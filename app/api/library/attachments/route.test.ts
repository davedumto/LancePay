import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockPrisma = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn(),
  },
  libraryAttachment: {
    findMany: vi.fn(),
    create: vi.fn(),
  },
}))

const mockVerifyAuthToken = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: mockVerifyAuthToken }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
  GET,
  POST,
  MAX_LIBRARY_ATTACHMENT_SIZE_BYTES,
  getStoredLibraryObject,
} from './route'

describe('GET, POST /api/library/attachments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'did:privy:user_lib_1' })
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user_lib_1' })
  })

  it('scopes GET and POST strictly to the authenticated user', async () => {
    mockPrisma.libraryAttachment.findMany.mockResolvedValue([
      {
        id: 'lib_att_1',
        userId: 'user_lib_1',
        fileName: 'w9-signed.pdf',
        fileUrl: 'https://storage.lancepay.io/library/user_lib_1/w9-signed.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 128000,
        createdAt: new Date('2026-06-05T10:00:00.000Z'),
      },
    ])

    const getReq = new NextRequest('http://localhost/api/library/attachments', {
      method: 'GET',
      headers: { authorization: 'Bearer valid_token' },
    })

    const getRes = await GET(getReq)
    expect(getRes.status).toBe(200)
    const getBody = await getRes.json()
    expect(mockPrisma.libraryAttachment.findMany).toHaveBeenCalledWith({
      where: { userId: 'user_lib_1' },
      orderBy: { createdAt: 'desc' },
    })
    expect(getBody.total).toBe(1)

    mockPrisma.libraryAttachment.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'lib_att_2',
        ...data,
        createdAt: new Date('2026-06-05T10:05:00.000Z'),
      }),
    )

    const postReq = new NextRequest(
      'http://localhost/api/library/attachments',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          userId: 'forged_victim_user_id',
          fileName: 'rate-card.pdf',
          fileUrl:
            'https://storage.lancepay.io/library/user_lib_1/rate-card.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 64000,
        }),
      },
    )

    const postRes = await POST(postReq)
    expect(postRes.status).toBe(201)
    const postBody = await postRes.json()
    expect(postBody.attachment.userId).toBe('user_lib_1')
    expect(mockPrisma.libraryAttachment.create).toHaveBeenCalledWith({
      data: {
        userId: 'user_lib_1',
        fileName: 'rate-card.pdf',
        fileUrl: 'https://storage.lancepay.io/library/user_lib_1/rate-card.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 64000,
      },
    })
  })

  it('stores file content via the storage mechanism and never persists raw file bytes in the database', async () => {
    const rawBytes = Buffer.from('LancePay Standard Service Agreement v1.0')
    const contentBase64 = rawBytes.toString('base64')

    mockPrisma.libraryAttachment.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'lib_att_stored',
        ...data,
        createdAt: new Date('2026-06-05T10:15:00.000Z'),
      }),
    )

    const req = new NextRequest('http://localhost/api/library/attachments', {
      method: 'POST',
      headers: {
        authorization: 'Bearer valid_token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        fileName: 'msa-template.pdf',
        mimeType: 'application/pdf',
        contentBase64,
      }),
    })

    const res = await POST(req)
    expect(res.status).toBe(201)
    const body = await res.json()

    expect(body.attachment.fileUrl).toMatch(
      /^https:\/\/storage\.lancepay\.io\/library\/user_lib_1\/[a-f0-9]+-msa-template\.pdf$/,
    )
    expect(body.attachment.sizeBytes).toBe(rawBytes.byteLength)

    // Verify storage object exists in storage layer
    const storedObj = getStoredLibraryObject(body.attachment.fileUrl)
    expect(storedObj).not.toBeNull()
    expect(storedObj?.sizeBytes).toBe(rawBytes.byteLength)

    // Verify raw file bytes were NOT sent to Prisma
    const createCallArg = mockPrisma.libraryAttachment.create.mock.calls[0][0]
    expect(Object.keys(createCallArg.data).sort()).toEqual([
      'fileName',
      'fileUrl',
      'mimeType',
      'sizeBytes',
      'userId',
    ])
    expect(JSON.stringify(createCallArg)).not.toContain(contentBase64)

    // Also reject raw inline data: URLs when no storage upload occurs
    const inlineDataReq = new NextRequest(
      'http://localhost/api/library/attachments',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          fileName: 'inline.png',
          fileUrl: `data:image/png;base64,${contentBase64}`,
          mimeType: 'image/png',
          sizeBytes: rawBytes.byteLength,
        }),
      },
    )
    const inlineDataRes = await POST(inlineDataReq)
    expect(inlineDataRes.status).toBe(400)
  })

  it('validates mimeType against the allowed set and sizeBytes against the maximum upload size', async () => {
    const disallowedMimeReq = new NextRequest(
      'http://localhost/api/library/attachments',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          fileName: 'script.sh',
          fileUrl: 'https://storage.lancepay.io/library/user_lib_1/script.sh',
          mimeType: 'application/x-sh',
          sizeBytes: 512,
        }),
      },
    )
    const disallowedMimeRes = await POST(disallowedMimeReq)
    expect(disallowedMimeRes.status).toBe(400)
    const disallowedMimeBody = await disallowedMimeRes.json()
    expect(disallowedMimeBody.code).toBe('UNSUPPORTED_MIME_TYPE')

    const tooLargeReq = new NextRequest(
      'http://localhost/api/library/attachments',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid_token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          fileName: 'oversized.pdf',
          fileUrl:
            'https://storage.lancepay.io/library/user_lib_1/oversized.pdf',
          mimeType: 'application/pdf',
          sizeBytes: MAX_LIBRARY_ATTACHMENT_SIZE_BYTES + 100,
        }),
      },
    )
    const tooLargeRes = await POST(tooLargeReq)
    expect(tooLargeRes.status).toBe(400)
    const tooLargeBody = await tooLargeRes.json()
    expect(tooLargeBody.code).toBe('INVALID_FILE_SIZE')
    expect(mockPrisma.libraryAttachment.create).not.toHaveBeenCalled()
  })
})
