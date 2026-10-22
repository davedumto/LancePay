import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    quote: { findFirst: vi.fn(), update: vi.fn() },
    product: { findMany: vi.fn() },
    invoice: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))
vi.mock('@/lib/utils', () => ({ generateInvoiceNumber: vi.fn(() => 'INV-001') }))

import { POST } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const NOW = new Date('2026-03-15T12:00:00.000Z')

type LineItem = { id: string; productId: string | null }

function makeQuote(overrides: Partial<{
  status: string
  expiresAt: Date | null
  invoiceId: string | null
  clientEmail: string
  clientName: string | null
  description: string
  amount: string
  currency: string
  lineItems: LineItem[]
}> = {}) {
  return {
    id: 'quote-1',
    status: 'sent',
    expiresAt: new Date('2026-04-01T00:00:00.000Z'),
    invoiceId: null,
    clientEmail: 'client@example.com',
    clientName: 'Test Client',
    description: 'Test Quote',
    amount: '100.00',
    currency: 'USD',
    lineItems: [],
    ...overrides,
  }
}

function makeInvoice(overrides: Partial<{
  id: string
  invoiceNumber: string
  status: string
  amount: string
  clientEmail: string
  clientName: string | null
  description: string
  currency: string
  paymentLink: string
  createdAt: Date
}> = {}) {
  return {
    id: 'invoice-1',
    invoiceNumber: 'INV-001',
    status: 'pending',
    amount: '100.00',
    clientEmail: 'client@example.com',
    clientName: 'Test Client',
    description: 'Test Quote',
    currency: 'USD',
    paymentLink: 'https://example.com/pay/INV-001',
    createdAt: NOW,
    ...overrides,
  }
}

function makeRequest(token: string | null = 'token') {
  return new NextRequest('http://localhost/api/quotes/quote-1/convert', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

const params = { params: Promise.resolve({ id: 'quote-1' }) }

async function call(token: string | null = 'token') {
  const res = await POST(makeRequest(token), params)
  return { res, body: await res.json() }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' } as never)
  vi.mocked(prisma.product.findMany).mockResolvedValue([] as never)

  // Mock $transaction to execute the callback synchronously
  vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) => {
    const tx = {
      invoice: { create: vi.fn().mockResolvedValue(makeInvoice()) },
      quote: { update: vi.fn() },
    }
    return callback(tx)
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('POST /api/quotes/[id]/convert', () => {
  describe('authentication and access control', () => {
    it('returns 401 without a bearer token', async () => {
      const { res, body } = await call(null)
      expect(res.status).toBe(401)
      expect(body).toEqual({ error: 'Unauthorized' })
      expect(prisma.quote.findFirst).not.toHaveBeenCalled()
    })

    it('returns 401 for an invalid token', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue(null as never)
      const { res, body } = await call()
      expect(res.status).toBe(401)
      expect(body).toEqual({ error: 'Invalid token' })
    })

    it('returns 404 when the authenticated user does not exist', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never)
      const { res, body } = await call()
      expect(res.status).toBe(404)
      expect(body).toEqual({ error: 'User not found' })
    })

    it('scopes the lookup to the owner and returns 404 for missing or foreign quotes', async () => {
      vi.mocked(prisma.quote.findFirst).mockResolvedValue(null as never)
      const { res, body } = await call()
      expect(res.status).toBe(404)
      expect(body).toEqual({ error: 'Quote not found' })
      expect(prisma.quote.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'quote-1', userId: 'user-1' } }),
      )
    })
  })

  it('converts an eligible quote to an invoice and returns the invoice', async () => {
    vi.mocked(prisma.quote.findFirst).mockResolvedValue(makeQuote() as never)

    const { res, body } = await call()

    expect(res.status).toBe(201)
    expect(body.message).toBe('Quote converted to invoice')
    expect(body.invoice).toEqual({
      id: 'invoice-1',
      invoiceNumber: 'INV-001',
      clientEmail: 'client@example.com',
      clientName: 'Test Client',
      description: 'Test Quote',
      amount: 100,
      currency: 'USD',
      status: 'pending',
      paymentLink: 'https://example.com/pay/INV-001',
      createdAt: NOW,
    })
  })

  it('marks the quote as converted and links it to the invoice', async () => {
    vi.mocked(prisma.quote.findFirst).mockResolvedValue(makeQuote() as never)

    const transactionCallback = vi.fn()
    vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) => {
      transactionCallback(callback)
      const tx = {
        invoice: { create: vi.fn().mockResolvedValue(makeInvoice()) },
        quote: { update: vi.fn() },
      }
      return callback(tx)
    })

    await call()

    expect(prisma.$transaction).toHaveBeenCalled()
  })

  it('rejects a quote with status converted', async () => {
    vi.mocked(prisma.quote.findFirst).mockResolvedValue(
      makeQuote({ status: 'converted' }) as never,
    )

    const { res, body } = await call()

    expect(res.status).toBe(403)
    expect(body.error).toBe('Quote is not eligible for conversion')
    expect(body.reasons).toEqual([
      { code: 'QUOTE_ALREADY_CONVERTED', message: 'Quote has already been converted to an invoice' },
    ])
  })

  it('rejects an expired quote', async () => {
    vi.mocked(prisma.quote.findFirst).mockResolvedValue(
      makeQuote({ expiresAt: new Date('2026-03-01T00:00:00.000Z') }) as never,
    )

    const { res, body } = await call()

    expect(res.status).toBe(403)
    expect(body.error).toBe('Quote is not eligible for conversion')
    expect(body.reasons).toEqual([
      { code: 'QUOTE_EXPIRED', message: 'Quote has expired' },
    ])
  })

  it('rejects a declined quote', async () => {
    vi.mocked(prisma.quote.findFirst).mockResolvedValue(
      makeQuote({ status: 'declined' }) as never,
    )

    const { res, body } = await call()

    expect(res.status).toBe(403)
    expect(body.reasons.map((r: { code: string }) => r.code)).toContain('QUOTE_DECLINED')
  })

  it('rejects a quote with deleted products', async () => {
    vi.mocked(prisma.quote.findFirst).mockResolvedValue(
      makeQuote({
        lineItems: [{ id: 'li-1', productId: 'prod-gone' }],
      }) as never,
    )
    vi.mocked(prisma.product.findMany).mockResolvedValue([] as never)

    const { res, body } = await call()

    expect(res.status).toBe(403)
    expect(body.reasons).toEqual([
      {
        code: 'PRODUCT_DELETED',
        message: 'A product referenced by this quote has been deleted',
        lineItemId: 'li-1',
        productId: 'prod-gone',
      },
    ])
  })

  it('rejects a quote with inactive products', async () => {
    vi.mocked(prisma.quote.findFirst).mockResolvedValue(
      makeQuote({
        lineItems: [{ id: 'li-1', productId: 'prod-1' }],
      }) as never,
    )
    vi.mocked(prisma.product.findMany).mockResolvedValue([
      { id: 'prod-1', isActive: false },
    ] as never)

    const { res, body } = await call()

    expect(res.status).toBe(403)
    expect(body.reasons).toEqual([
      {
        code: 'PRODUCT_INACTIVE',
        message: 'A product referenced by this quote is no longer active',
        lineItemId: 'li-1',
        productId: 'prod-1',
      },
    ])
  })

  it('returns every failing condition when several apply', async () => {
    vi.mocked(prisma.quote.findFirst).mockResolvedValue(
      makeQuote({
        status: 'converted',
        expiresAt: new Date('2026-01-01T00:00:00.000Z'),
        lineItems: [{ id: 'li-1', productId: 'prod-gone' }],
      }) as never,
    )
    vi.mocked(prisma.product.findMany).mockResolvedValue([] as never)

    const { res, body } = await call()

    expect(res.status).toBe(403)
    expect(body.reasons.map((r: { code: string }) => r.code)).toEqual([
      'QUOTE_ALREADY_CONVERTED',
      'QUOTE_EXPIRED',
      'PRODUCT_DELETED',
    ])
  })

  it('returns a generic 500 without leaking database errors', async () => {
    vi.mocked(prisma.quote.findFirst).mockRejectedValue(new Error('connection refused'))
    const { res, body } = await call()
    expect(res.status).toBe(500)
    expect(body).toEqual({ error: 'Failed to convert quote' })
  })
})
