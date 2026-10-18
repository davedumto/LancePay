import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockVerifyAuthToken = vi.fn()
const mockUserFindUnique = vi.fn()
const mockInvoiceFindUnique = vi.fn()
const mockMessageFindMany = vi.fn()
const mockMessageCount = vi.fn()
const mockMessageCreate = vi.fn()

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: (...args: unknown[]) => mockVerifyAuthToken(...args),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
    },
    invoice: {
      findUnique: (...args: unknown[]) => mockInvoiceFindUnique(...args),
    },
    invoiceMessage: {
      findMany: (...args: unknown[]) => mockMessageFindMany(...args),
      count: (...args: unknown[]) => mockMessageCount(...args),
      create: (...args: unknown[]) => mockMessageCreate(...args),
    },
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}))

import { GET, POST } from './route'

function makeRequest(
  url: string,
  options?: { method?: string; token?: string; body?: unknown },
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (options?.token) {
    headers.authorization = `Bearer ${options.token}`
  }
  return new NextRequest(url, {
    method: options?.method ?? 'POST',
    headers,
    body:
      options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  })
}

describe('Invoice Threaded Messages API (/api/invoices/[id]/messages)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'freelancer-1' })
    mockUserFindUnique.mockResolvedValue({
      id: 'freelancer-1',
      privyId: 'freelancer-1',
      name: 'Freelancer One',
      email: 'freelancer@example.com',
      role: 'user',
    })
    mockInvoiceFindUnique.mockResolvedValue({
      id: 'inv-1',
      userId: 'freelancer-1',
      clientName: 'Acme Corp',
      clientEmail: 'billing@acme.com',
    })
  })

  it('validates senderType against the allowed set and requires senderId when senderType is not a guest client', async () => {
    const reqBadType = makeRequest(
      'http://localhost/api/invoices/inv-1/messages',
      {
        token: 'valid-token',
        body: {
          senderType: 'anonymous_bot',
          content: 'Hello',
        },
      },
    )
    const resBadType = await POST(reqBadType, { params: { id: 'inv-1' } })
    expect(resBadType.status).toBe(400)
    const jsonBadType = await resBadType.json()
    expect(jsonBadType.code).toBe('INVALID_SENDER_TYPE')

    // Non-client senderType with explicit null senderId and no authenticated user -> 400 SENDER_ID_REQUIRED
    const reqMissingSenderId = makeRequest(
      'http://localhost/api/invoices/inv-1/messages',
      {
        body: {
          senderType: 'freelancer',
          senderId: null,
          content: 'Missing senderId',
        },
      },
    )
    const resMissingSenderId = await POST(reqMissingSenderId, {
      params: { id: 'inv-1' },
    })
    expect(resMissingSenderId.status).toBe(400)
    const jsonMissing = await resMissingSenderId.json()
    expect(jsonMissing.code).toBe('SENDER_ID_REQUIRED')

    // Guest client without an account (senderType: 'client', senderId: null) is allowed!
    mockMessageCreate.mockImplementation(async ({ data }: any) => ({
      id: 'msg-guest',
      ...data,
      createdAt: new Date('2026-04-01T10:00:00Z'),
    }))

    const reqGuestClient = makeRequest(
      'http://localhost/api/invoices/inv-1/messages',
      {
        body: {
          senderType: 'client',
          senderName: 'Guest Client',
          content: 'Can we split this into two payments?',
        },
      },
    )
    const resGuest = await POST(reqGuestClient, { params: { id: 'inv-1' } })
    expect(resGuest.status).toBe(201)
    const jsonGuest = await resGuest.json()
    expect(jsonGuest.message.senderType).toBe('client')
    expect(jsonGuest.message.senderId).toBeNull()
  })

  it('excludes isInternal messages from any client-facing view while including them for the invoice owner', async () => {
    const t1 = new Date('2026-04-01T10:00:00Z')
    const t2 = new Date('2026-04-01T10:05:00Z')
    const t3 = new Date('2026-04-01T10:10:00Z')

    const allMessages = [
      {
        id: 'msg-1',
        invoiceId: 'inv-1',
        senderId: 'freelancer-1',
        senderType: 'freelancer',
        senderName: 'Freelancer One',
        content: 'Invoice issued for April milestone.',
        isInternal: false,
        createdAt: t1,
      },
      {
        id: 'msg-2-internal',
        invoiceId: 'inv-1',
        senderId: 'freelancer-1',
        senderType: 'freelancer',
        senderName: 'Freelancer One',
        content: 'Internal note: approved 5% early-pay discount if asked.',
        isInternal: true,
        createdAt: t2,
      },
      {
        id: 'msg-3',
        invoiceId: 'inv-1',
        senderId: null,
        senderType: 'client',
        senderName: 'Acme Corp',
        content: 'Received, thank you!',
        isInternal: false,
        createdAt: t3,
      },
    ]

    mockMessageFindMany.mockResolvedValue(allMessages)
    mockMessageCount.mockResolvedValue(2)

    // Client-facing request (unauthenticated guest client or ?view=client)
    const reqClientView = makeRequest(
      'http://localhost/api/invoices/inv-1/messages?view=client&page=1&limit=10',
      {
        method: 'GET',
      },
    )
    const resClientView = await GET(reqClientView, { params: { id: 'inv-1' } })
    expect(resClientView.status).toBe(200)
    const jsonClient = await resClientView.json()
    expect(jsonClient.view).toBe('client')
    expect(jsonClient.messages.map((m: any) => m.id)).toEqual([
      'msg-1',
      'msg-3',
    ])
    expect(
      jsonClient.messages.some((m: any) => m.isInternal === true),
    ).toBe(false)

    // Owner view (authenticated freelancer who owns the invoice)
    mockMessageCount.mockResolvedValue(3)
    const reqOwnerView = makeRequest(
      'http://localhost/api/invoices/inv-1/messages?page=1&limit=10',
      {
        method: 'GET',
        token: 'valid-token',
      },
    )
    const resOwnerView = await GET(reqOwnerView, { params: { id: 'inv-1' } })
    expect(resOwnerView.status).toBe(200)
    const jsonOwner = await resOwnerView.json()
    expect(jsonOwner.view).toBe('owner')
    // Ordered by createdAt ascending
    expect(jsonOwner.messages.map((m: any) => m.id)).toEqual([
      'msg-1',
      'msg-2-internal',
      'msg-3',
    ])
    expect(mockMessageFindMany).toHaveBeenLastCalledWith({
      where: { invoiceId: 'inv-1' },
      orderBy: { createdAt: 'asc' },
      skip: 0,
      take: 10,
    })
  })
})
