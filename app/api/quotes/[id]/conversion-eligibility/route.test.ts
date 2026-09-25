import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    quote: { findFirst: vi.fn(), update: vi.fn() },
    product: { findMany: vi.fn() },
    invoice: { create: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { GET } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const NOW = new Date('2026-03-15T12:00:00.000Z')

type LineItem = { id: string; productId: string | null }

function makeQuote(overrides: Partial<{
  status: string
  expiresAt: Date | null
  invoiceId: string | null
  lineItems: LineItem[]
}> = {}) {
  return {
    id: 'quote-1',
    status: 'sent',
    expiresAt: new Date('2026-04-01T00:00:00.000Z'),
    invoiceId: null,
    lineItems: [],
    ...overrides,
  }
}

function makeRequest(token: string | null = 'token') {
  return new NextRequest('http://localhost/api/quotes/quote-1/conversion-eligibility', {
    method: 'GET',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

const params = { params: Promise.resolve({ id: 'quote-1' }) }

async function call(token: string | null = 'token') {
  const res = await GET(makeRequest(token), params)
  return { res, body: await res.json() }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' } as never)
  vi.mocked(prisma.product.findMany).mockResolvedValue([] as never)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('GET /api/quotes/[id]/conversion-eligibility', () => {
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

  it('reports an open, unexpired quote without product references as eligible', async () => {
    vi.mocked(prisma.quote.findFirst).mockResolvedValue(makeQuote() as never)

    const { res, body } = await call()

    expect(res.status).toBe(200)
    expect(body).toEqual({
      quoteId: 'quote-1',
      eligible: true,
      reasons: [],
      checkedAt: NOW.toISOString(),
    })
    expect(prisma.product.findMany).not.toHaveBeenCalled()
  })

  it('reports a quote whose referenced products are all active as eligible', async () => {
    vi.mocked(prisma.quote.findFirst).mockResolvedValue(
      makeQuote({
        lineItems: [
          { id: 'li-1', productId: 'prod-1' },
          { id: 'li-2', productId: null },
          { id: 'li-3', productId: 'prod-1' },
        ],
      }) as never,
    )
    vi.mocked(prisma.product.findMany).mockResolvedValue([{ id: 'prod-1', isActive: true }] as never)

    const { body } = await call()

    expect(body.eligible).toBe(true)
    expect(prisma.product.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['prod-1'] }, userId: 'user-1' },
      select: { id: true, isActive: true },
    })
  })

  it('treats a quote without an expiry date as never expiring', async () => {
    vi.mocked(prisma.quote.findFirst).mockResolvedValue(makeQuote({ expiresAt: null }) as never)
    const { body } = await call()
    expect(body.eligible).toBe(true)
  })

  describe('expiry', () => {
    it('rejects a quote whose expiresAt is in the past', async () => {
      vi.mocked(prisma.quote.findFirst).mockResolvedValue(
        makeQuote({ expiresAt: new Date('2026-03-01T00:00:00.000Z') }) as never,
      )
      const { res, body } = await call()
      expect(res.status).toBe(200)
      expect(body.eligible).toBe(false)
      expect(body.reasons).toEqual([{ code: 'QUOTE_EXPIRED', message: 'Quote has expired' }])
    })

    it('treats the exact expiresAt instant as expired', async () => {
      vi.mocked(prisma.quote.findFirst).mockResolvedValue(makeQuote({ expiresAt: NOW }) as never)
      const { body } = await call()
      expect(body.reasons.map((r: { code: string }) => r.code)).toEqual(['QUOTE_EXPIRED'])
    })

    it('is still eligible one millisecond before expiry', async () => {
      vi.mocked(prisma.quote.findFirst).mockResolvedValue(
        makeQuote({ expiresAt: new Date(NOW.getTime() + 1) }) as never,
      )
      const { body } = await call()
      expect(body.eligible).toBe(true)
    })

    it('rejects a quote already marked expired even if expiresAt is in the future', async () => {
      vi.mocked(prisma.quote.findFirst).mockResolvedValue(makeQuote({ status: 'expired' }) as never)
      const { body } = await call()
      expect(body.reasons.map((r: { code: string }) => r.code)).toEqual(['QUOTE_EXPIRED'])
    })
  })

  describe('prior conversion', () => {
    it('rejects a quote with status converted', async () => {
      vi.mocked(prisma.quote.findFirst).mockResolvedValue(makeQuote({ status: 'converted' }) as never)
      const { body } = await call()
      expect(body.eligible).toBe(false)
      expect(body.reasons).toEqual([
        { code: 'QUOTE_ALREADY_CONVERTED', message: 'Quote has already been converted to an invoice' },
      ])
    })

    it('rejects a quote that is already linked to an invoice regardless of status', async () => {
      vi.mocked(prisma.quote.findFirst).mockResolvedValue(
        makeQuote({ status: 'accepted', invoiceId: 'inv-9' }) as never,
      )
      const { body } = await call()
      expect(body.reasons.map((r: { code: string }) => r.code)).toEqual(['QUOTE_ALREADY_CONVERTED'])
    })
  })

  it.each(['declined', 'rejected'])('rejects a %s quote', async (status) => {
    vi.mocked(prisma.quote.findFirst).mockResolvedValue(makeQuote({ status }) as never)
    const { body } = await call()
    expect(body.reasons).toEqual([{ code: 'QUOTE_DECLINED', message: `Quote was ${status} by the client` }])
  })

  describe('referenced products', () => {
    it('reports a product that no longer exists as deleted, per line item', async () => {
      vi.mocked(prisma.quote.findFirst).mockResolvedValue(
        makeQuote({
          lineItems: [
            { id: 'li-1', productId: 'prod-gone' },
            { id: 'li-2', productId: 'prod-ok' },
          ],
        }) as never,
      )
      vi.mocked(prisma.product.findMany).mockResolvedValue([{ id: 'prod-ok', isActive: true }] as never)

      const { body } = await call()

      expect(body.eligible).toBe(false)
      expect(body.reasons).toEqual([
        {
          code: 'PRODUCT_DELETED',
          message: 'A product referenced by this quote has been deleted',
          lineItemId: 'li-1',
          productId: 'prod-gone',
        },
      ])
    })

    it('reports a deactivated product as inactive', async () => {
      vi.mocked(prisma.quote.findFirst).mockResolvedValue(
        makeQuote({ lineItems: [{ id: 'li-1', productId: 'prod-1' }] }) as never,
      )
      vi.mocked(prisma.product.findMany).mockResolvedValue([{ id: 'prod-1', isActive: false }] as never)

      const { body } = await call()

      expect(body.reasons).toEqual([
        {
          code: 'PRODUCT_INACTIVE',
          message: 'A product referenced by this quote is no longer active',
          lineItemId: 'li-1',
          productId: 'prod-1',
        },
      ])
    })
  })

  it('returns every failing condition when several apply', async () => {
    vi.mocked(prisma.quote.findFirst).mockResolvedValue(
      makeQuote({
        status: 'converted',
        invoiceId: 'inv-1',
        expiresAt: new Date('2026-01-01T00:00:00.000Z'),
        lineItems: [
          { id: 'li-1', productId: 'prod-gone' },
          { id: 'li-2', productId: 'prod-off' },
        ],
      }) as never,
    )
    vi.mocked(prisma.product.findMany).mockResolvedValue([{ id: 'prod-off', isActive: false }] as never)

    const { body } = await call()

    expect(body.eligible).toBe(false)
    expect(body.reasons.map((r: { code: string }) => r.code)).toEqual([
      'QUOTE_ALREADY_CONVERTED',
      'QUOTE_EXPIRED',
      'PRODUCT_DELETED',
      'PRODUCT_INACTIVE',
    ])
  })

  it('never mutates the quote or creates an invoice', async () => {
    vi.mocked(prisma.quote.findFirst).mockResolvedValue(makeQuote() as never)
    await call()
    expect(prisma.quote.update).not.toHaveBeenCalled()
    expect(prisma.invoice.create).not.toHaveBeenCalled()
  })

  it('returns a generic 500 without leaking database errors', async () => {
    vi.mocked(prisma.quote.findFirst).mockRejectedValue(new Error('connection refused at 10.0.0.1'))
    const { res, body } = await call()
    expect(res.status).toBe(500)
    expect(body).toEqual({ error: 'Failed to check quote conversion eligibility' })
  })
})
