import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockPrisma = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn(),
  },
  invoice: {
    findUnique: vi.fn(),
  },
  libraryAttachment: {
    findUnique: vi.fn(),
  },
  invoiceAttachment: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  },
}))

const mockVerifyAuthToken = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: mockVerifyAuthToken }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { GET, POST, DELETE, MAX_ATTACHMENT_SIZE_BYTES } from './route'

describe('GET, POST, DELETE /api/invoices/[id]/attachments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'did:privy:uploader_1' })
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user_uploader_1',
      email: 'uploader@example.com',
    })
    mockPrisma.invoice.findUnique.mockResolvedValue({
      id: 'inv_100',
      userId: 'user_owner_1',
      clientEmail: 'client@example.com',
    })
  })

  it('lists attachments on GET and records uploadedBy from the authenticated user on POST', async () => {
    mockPrisma.invoiceAttachment.findMany.mockResolvedValue([
      {
        id: 'att_1',
        invoiceId: 'inv_100',
        uploadedBy: 'user_uploader_1',
        fileName: 'scope-of-work.pdf',
        fileUrl: 'https://storage.lancepay.io/invoices/inv_100/scope-of-work.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 245760,
        createdAt: new Date('2026-06-05T10:00:00.000Z'),
      },
    ])

    const getReq = new NextRequest(
      'http://localhost/api/invoices/inv_100/attachments',
      {
        method: 'GET',
        headers: { authorization: 'Bearer valid_token' },
      },
    )
    const getRes = await GET(getReq, { params: { id: 'inv_100' } })
    expect(getRes.status).toBe(200)
    const getBody = await getRes.json()
    expect(getBody.total).toBe(1)
    expect(getBody.attachments[0].fileName).toBe('scope-of-work.pdf')

    mockPrisma.invoiceAttachment.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'att_2',
        ...data,
        createdAt: new Date('2026-06-05T11:00:00.000Z'),
      }),
    )

    const postReq = new NextRequest(
      'http://localhost/api/invoices/inv_100/attachments',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          uploadedBy: 'forged_other_user',
          fileName: 'receipt.png',
          fileUrl: 'https://storage.lancepay.io/invoices/inv_100/receipt.png',
          mimeType: 'image/png',
          sizeBytes: 51200,
        }),
      },
    )

    const postRes = await POST(postReq, { params: { id: 'inv_100' } })
    expect(postRes.status).toBe(201)
    const postBody = await postRes.json()

    expect(postBody.attachment.uploadedBy).toBe('user_uploader_1')
    expect(mockPrisma.invoiceAttachment.create).toHaveBeenCalledWith({
      data: {
        invoiceId: 'inv_100',
        uploadedBy: 'user_uploader_1',
        fileName: 'receipt.png',
        fileUrl: 'https://storage.lancepay.io/invoices/inv_100/receipt.png',
        mimeType: 'image/png',
        sizeBytes: 51200,
      },
    })
  })

  it('validates mimeType and sizeBytes consistently with the library attachment endpoint', async () => {
    const badMimeReq = new NextRequest(
      'http://localhost/api/invoices/inv_100/attachments',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          fileName: 'payload.exe',
          fileUrl: 'https://storage.lancepay.io/invoices/inv_100/payload.exe',
          mimeType: 'application/x-msdownload',
          sizeBytes: 1024,
        }),
      },
    )

    const badMimeRes = await POST(badMimeReq, { params: { id: 'inv_100' } })
    expect(badMimeRes.status).toBe(400)
    const badMimeBody = await badMimeRes.json()
    expect(badMimeBody.code).toBe('UNSUPPORTED_MIME_TYPE')

    const oversizedReq = new NextRequest(
      'http://localhost/api/invoices/inv_100/attachments',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          fileName: 'huge-archive.zip',
          fileUrl: 'https://storage.lancepay.io/invoices/inv_100/huge-archive.zip',
          mimeType: 'application/zip',
          sizeBytes: MAX_ATTACHMENT_SIZE_BYTES + 1,
        }),
      },
    )

    const oversizedRes = await POST(oversizedReq, { params: { id: 'inv_100' } })
    expect(oversizedRes.status).toBe(400)
    const oversizedBody = await oversizedRes.json()
    expect(oversizedBody.code).toBe('INVALID_FILE_SIZE')
    expect(mockPrisma.invoiceAttachment.create).not.toHaveBeenCalled()
  })

  it('permits DELETE only by the invoice owner or original uploader and rejects third parties with 403', async () => {
    mockPrisma.invoiceAttachment.findUnique.mockResolvedValue({
      id: 'att_del_1',
      invoiceId: 'inv_100',
      uploadedBy: 'user_uploader_1',
      fileName: 'contract.pdf',
      fileUrl: 'https://storage.lancepay.io/invoices/inv_100/contract.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 12000,
    })

    // 1. Third-party user (neither invoice owner 'user_owner_1' nor uploader 'user_uploader_1') -> 403
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'user_stranger_99',
      email: 'stranger@example.com',
    })
    const forbiddenReq = new NextRequest(
      'http://localhost/api/invoices/inv_100/attachments?attachmentId=att_del_1',
      {
        method: 'DELETE',
        headers: { authorization: 'Bearer valid_token' },
      },
    )
    const forbiddenRes = await DELETE(forbiddenReq, {
      params: { id: 'inv_100' },
    })
    expect(forbiddenRes.status).toBe(403)
    expect(mockPrisma.invoiceAttachment.delete).not.toHaveBeenCalled()

    // 2. Original uploader ('user_uploader_1') -> 200
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'user_uploader_1',
      email: 'uploader@example.com',
    })
    mockPrisma.invoiceAttachment.delete.mockResolvedValueOnce({
      id: 'att_del_1',
    })
    const uploaderReq = new NextRequest(
      'http://localhost/api/invoices/inv_100/attachments?attachmentId=att_del_1',
      {
        method: 'DELETE',
        headers: { authorization: 'Bearer valid_token' },
      },
    )
    const uploaderRes = await DELETE(uploaderReq, { params: { id: 'inv_100' } })
    expect(uploaderRes.status).toBe(200)
    expect(mockPrisma.invoiceAttachment.delete).toHaveBeenCalledWith({
      where: { id: 'att_del_1' },
    })

    // 3. Invoice owner ('user_owner_1') -> 200
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'user_owner_1',
      email: 'owner@example.com',
    })
    mockPrisma.invoiceAttachment.delete.mockResolvedValueOnce({
      id: 'att_del_1',
    })
    const ownerReq = new NextRequest(
      'http://localhost/api/invoices/inv_100/attachments',
      {
        method: 'DELETE',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ attachmentId: 'att_del_1' }),
      },
    )
    const ownerRes = await DELETE(ownerReq, { params: { id: 'inv_100' } })
    expect(ownerRes.status).toBe(200)
    const ownerBody = await ownerRes.json()
    expect(ownerBody).toEqual({
      deleted: true,
      attachmentId: 'att_del_1',
      invoiceId: 'inv_100',
    })
  })
})
