import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const invoiceFindUnique = vi.fn()
const messageFindMany = vi.fn()
const loggerError = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/logger', () => ({ logger: { error: loggerError } }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    invoice: { findUnique: invoiceFindUnique },
    invoiceMessage: { findMany: messageFindMany },
  },
}))

const BASE_URL = 'http://localhost/api/routes-d/invoices/inv_1/messages'

function makeRequest(headers: Record<string, string> = { authorization: 'Bearer token' }) {
  return new NextRequest(BASE_URL, {
    method: 'GET',
    headers,
  })
}

describe('GET /api/routes-d/invoices/[id]/messages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when the authorization header is missing', async () => {
    const { GET } = await import('@/app/api/routes-d/invoices/[id]/messages/route')
    const response = await GET(makeRequest({}), {
      params: Promise.resolve({ id: 'inv_1' }),
    })

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
    expect(verifyAuthToken).not.toHaveBeenCalled()
  })

  it('returns 404 when the invoice does not exist', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindUnique.mockResolvedValue(null)

    const { GET } = await import('@/app/api/routes-d/invoices/[id]/messages/route')
    const response = await GET(makeRequest(), {
      params: Promise.resolve({ id: 'missing_invoice' }),
    })

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Invoice not found' })
    expect(messageFindMany).not.toHaveBeenCalled()
  })

  it('returns 403 when the invoice belongs to another user', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindUnique.mockResolvedValue({ id: 'inv_1', userId: 'user_2' })

    const { GET } = await import('@/app/api/routes-d/invoices/[id]/messages/route')
    const response = await GET(makeRequest(), {
      params: Promise.resolve({ id: 'inv_1' }),
    })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'Forbidden' })
    expect(messageFindMany).not.toHaveBeenCalled()
  })

  it('lists invoice messages for the invoice owner', async () => {
    const createdAt = new Date('2026-01-01T12:00:00.000Z')
    const messages = [
      {
        id: 'msg_1',
        senderType: 'client',
        senderName: 'Ada',
        content: 'Thanks, paid today.',
        createdAt,
      },
    ]

    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindUnique.mockResolvedValue({ id: 'inv_1', userId: 'user_1' })
    messageFindMany.mockResolvedValue(messages)

    const { GET } = await import('@/app/api/routes-d/invoices/[id]/messages/route')
    const response = await GET(makeRequest(), {
      params: Promise.resolve({ id: 'inv_1' }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      messages: [
        {
          ...messages[0],
          createdAt: createdAt.toISOString(),
        },
      ],
    })
    expect(messageFindMany).toHaveBeenCalledWith({
      where: { invoiceId: 'inv_1' },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        senderType: true,
        senderName: true,
        content: true,
        createdAt: true,
      },
    })
  })
})
