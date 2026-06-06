import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { findUnique: vi.fn() },
    invoiceMessage: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET, POST } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedInvoiceFind = vi.mocked(prisma.invoice.findUnique)
const mockedMessageFindMany = vi.mocked(prisma.invoiceMessage.findMany)
const mockedMessageCreate = vi.mocked(prisma.invoiceMessage.create)

const invoiceId = '550e8400-e29b-41d4-a716-446655440000'
const baseUser = {
  id: 'user-1',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
}

function makeGET(id = invoiceId, auth = true): NextRequest {
  return new NextRequest(`http://localhost/api/routes-b/invoices/${id}/messages`, {
    method: 'GET',
    headers: auth ? { authorization: 'Bearer token' } : {},
  })
}

function makePOST(body: unknown, id = invoiceId, auth = true): NextRequest {
  return new NextRequest(`http://localhost/api/routes-b/invoices/${id}/messages`, {
    method: 'POST',
    headers: auth ? { authorization: 'Bearer token' } : {},
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function makeParams(id = invoiceId) {
  return { params: Promise.resolve({ id }) }
}

describe('GET /api/routes-b/invoices/[id]/messages', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFind.mockResolvedValue(baseUser as never)
    mockedInvoiceFind.mockResolvedValue({ id: invoiceId, userId: 'user-1' } as never)
  })

  it('lists messages for the invoice owner', async () => {
    const createdAt = new Date('2026-01-01T12:00:00.000Z')
    mockedMessageFindMany.mockResolvedValue([
      {
        id: 'msg-1',
        invoiceId,
        senderId: 'user-1',
        senderType: 'freelancer',
        senderName: 'Ada Lovelace',
        content: 'Thanks for the update.',
        attachmentUrl: null,
        isInternal: false,
        createdAt,
      },
    ] as never)

    const res = await GET(makeGET(), makeParams())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.messages).toEqual([
      {
        id: 'msg-1',
        invoiceId,
        senderId: 'user-1',
        senderType: 'freelancer',
        senderName: 'Ada Lovelace',
        content: 'Thanks for the update.',
        attachmentUrl: null,
        isInternal: false,
        createdAt: createdAt.toISOString(),
      },
    ])
    expect(mockedMessageFindMany).toHaveBeenCalledWith({
      where: { invoiceId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        invoiceId: true,
        senderId: true,
        senderType: true,
        senderName: true,
        content: true,
        attachmentUrl: true,
        isInternal: true,
        createdAt: true,
      },
    })
  })

  it('returns 401 when authorization is missing', async () => {
    const res = await GET(makeGET(invoiceId, false), makeParams())
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.error.code).toBe('UNAUTHORIZED')
    expect(mockedInvoiceFind).not.toHaveBeenCalled()
  })

  it('returns 400 for a non-UUID invoice id', async () => {
    const res = await GET(makeGET('not-a-uuid'), makeParams('not-a-uuid'))
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('BAD_REQUEST')
    expect(body.error.fields.id).toBe('Must be a valid UUID')
    expect(mockedInvoiceFind).not.toHaveBeenCalled()
  })

  it('returns 404 when the invoice does not exist', async () => {
    mockedInvoiceFind.mockResolvedValue(null)

    const res = await GET(makeGET(), makeParams())
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
    expect(body.error.message).toBe('Invoice not found')
    expect(mockedMessageFindMany).not.toHaveBeenCalled()
  })

  it('returns 404 when the invoice belongs to another user', async () => {
    mockedInvoiceFind.mockResolvedValue({ id: invoiceId, userId: 'other-user' } as never)

    const res = await GET(makeGET(), makeParams())
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
    expect(mockedMessageFindMany).not.toHaveBeenCalled()
  })
})

describe('POST /api/routes-b/invoices/[id]/messages', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFind.mockResolvedValue(baseUser as never)
    mockedInvoiceFind.mockResolvedValue({ id: invoiceId, userId: 'user-1' } as never)
  })

  it('creates a freelancer message for the invoice owner', async () => {
    const createdAt = new Date('2026-01-01T12:00:00.000Z')
    mockedMessageCreate.mockResolvedValue({
      id: 'msg-1',
      invoiceId,
      senderId: 'user-1',
      senderType: 'freelancer',
      senderName: 'Ada Lovelace',
      content: 'Hello client',
      attachmentUrl: null,
      isInternal: false,
      createdAt,
    } as never)

    const res = await POST(makePOST({ content: '  Hello client  ' }), makeParams())
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.message.content).toBe('Hello client')
    expect(body.message.createdAt).toBe(createdAt.toISOString())
    expect(mockedMessageCreate).toHaveBeenCalledWith({
      data: {
        invoiceId,
        senderId: 'user-1',
        senderType: 'freelancer',
        senderName: 'Ada Lovelace',
        content: 'Hello client',
      },
      select: {
        id: true,
        invoiceId: true,
        senderId: true,
        senderType: true,
        senderName: true,
        content: true,
        attachmentUrl: true,
        isInternal: true,
        createdAt: true,
      },
    })
  })

  it('returns 400 when content is missing', async () => {
    const res = await POST(makePOST({}), makeParams())
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('BAD_REQUEST')
    expect(body.error.fields.content).toContain('Required')
    expect(mockedMessageCreate).not.toHaveBeenCalled()
  })

  it('returns 400 when content is too long', async () => {
    const res = await POST(makePOST({ content: 'x'.repeat(1001) }), makeParams())
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('BAD_REQUEST')
    expect(body.error.fields.content).toContain('Content must be 1000 characters or fewer')
    expect(mockedMessageCreate).not.toHaveBeenCalled()
  })

  it('returns 400 when JSON is malformed', async () => {
    const res = await POST(makePOST('{'), makeParams())
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('BAD_REQUEST')
    expect(body.error.message).toBe('Invalid JSON body')
    expect(mockedMessageCreate).not.toHaveBeenCalled()
  })
})
