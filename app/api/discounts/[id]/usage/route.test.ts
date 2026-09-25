import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// Redemption rows plus the status of the invoice each was applied to. The
// count mock evaluates the route's real `where` clause against them, so these
// tests check which redemptions are counted, not just that count() was called.
interface RedemptionFixture {
  discountId: string
  status: string
  invoiceStatus: string
}

const fixtures = vi.hoisted(() => ({ redemptions: [] as RedemptionFixture[] }))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    discount: { findFirst: vi.fn() },
    discountRedemption: {
      count: vi.fn(
        async ({
          where,
        }: {
          where: { discountId: string; status: string; invoice: { status: { not: string } } }
        }) =>
          fixtures.redemptions.filter(
            (r) =>
              r.discountId === where.discountId &&
              r.status === where.status &&
              r.invoiceStatus !== where.invoice.status.not,
          ).length,
      ),
    },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { GET } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

function discount(maxRedemptions: number | null) {
  return { id: 'disc-1', code: 'SPRING10', active: true, maxRedemptions }
}

function redemptions(...rows: [status: string, invoiceStatus: string][]) {
  fixtures.redemptions = rows.map(([status, invoiceStatus]) => ({ discountId: 'disc-1', status, invoiceStatus }))
}

async function call(token: string | null = 'token') {
  const req = new NextRequest('http://localhost/api/discounts/disc-1/usage', {
    method: 'GET',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  const res = await GET(req, { params: Promise.resolve({ id: 'disc-1' }) })
  return { res, body: await res.json() }
}

beforeEach(() => {
  vi.clearAllMocks()
  fixtures.redemptions = []
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' } as never)
  vi.mocked(prisma.discount.findFirst).mockResolvedValue(discount(3) as never)
})

describe('GET /api/discounts/[id]/usage', () => {
  describe('authentication and ownership', () => {
    it('returns 401 without a bearer token', async () => {
      const { res } = await call(null)
      expect(res.status).toBe(401)
      expect(prisma.discount.findFirst).not.toHaveBeenCalled()
    })

    it('returns 401 for an invalid token', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue(null as never)
      const { res } = await call()
      expect(res.status).toBe(401)
    })

    it('returns 404 when the user does not exist', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never)
      const { res } = await call()
      expect(res.status).toBe(404)
    })

    it('scopes the lookup to the owner and returns 404 for missing or foreign discounts', async () => {
      vi.mocked(prisma.discount.findFirst).mockResolvedValue(null as never)
      const { res, body } = await call()
      expect(res.status).toBe(404)
      expect(body).toEqual({ error: 'Discount not found' })
      expect(prisma.discount.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'disc-1', userId: 'user-1' } }),
      )
      expect(prisma.discountRedemption.count).not.toHaveBeenCalled()
    })
  })

  it('reports zero redemptions for an unused limited discount', async () => {
    const { res, body } = await call()
    expect(res.status).toBe(200)
    expect(body).toEqual({
      discountId: 'disc-1',
      code: 'SPRING10',
      active: true,
      limited: true,
      limit: 3,
      redemptions: 0,
      remaining: 3,
      limitReached: false,
    })
  })

  it('counts successful redemptions below the limit', async () => {
    redemptions(['succeeded', 'paid'], ['succeeded', 'pending'])
    const { body } = await call()
    expect(body).toMatchObject({ redemptions: 2, remaining: 1, limitReached: false })
  })

  it('flags the limit as reached when redemptions equal the limit', async () => {
    redemptions(['succeeded', 'paid'], ['succeeded', 'paid'], ['succeeded', 'overdue'])
    const { body } = await call()
    expect(body).toMatchObject({ redemptions: 3, remaining: 0, limitReached: true })
  })

  it('never reports negative remaining when redemptions exceed a lowered limit', async () => {
    vi.mocked(prisma.discount.findFirst).mockResolvedValue(discount(1) as never)
    redemptions(['succeeded', 'paid'], ['succeeded', 'paid'])
    const { body } = await call()
    expect(body).toMatchObject({ limit: 1, redemptions: 2, remaining: 0, limitReached: true })
  })

  it('excludes redemptions whose invoice was later voided', async () => {
    redemptions(['succeeded', 'paid'], ['succeeded', 'voided'], ['succeeded', 'voided'])
    const { body } = await call()
    expect(body).toMatchObject({ redemptions: 1, remaining: 2, limitReached: false })
  })

  it('excludes pending, failed and rejected redemption attempts', async () => {
    redemptions(['pending', 'pending'], ['failed', 'pending'], ['rejected', 'paid'], ['succeeded', 'paid'])
    const { body } = await call()
    expect(body).toMatchObject({ redemptions: 1, remaining: 2 })
  })

  it('ignores redemptions of other discounts', async () => {
    fixtures.redemptions = [
      { discountId: 'disc-other', status: 'succeeded', invoiceStatus: 'paid' },
      { discountId: 'disc-1', status: 'succeeded', invoiceStatus: 'paid' },
    ]
    const { body } = await call()
    expect(body.redemptions).toBe(1)
  })

  it('reports an unlimited discount with null limit and remaining, never zero', async () => {
    vi.mocked(prisma.discount.findFirst).mockResolvedValue(discount(null) as never)
    redemptions(['succeeded', 'paid'], ['succeeded', 'paid'], ['succeeded', 'paid'], ['succeeded', 'paid'])
    const { body } = await call()
    expect(body).toMatchObject({
      limited: false,
      limit: null,
      redemptions: 4,
      remaining: null,
      limitReached: false,
    })
  })

  it('returns a generic 500 without leaking database errors', async () => {
    vi.mocked(prisma.discount.findFirst).mockRejectedValue(new Error('timeout on host db-1'))
    const { res, body } = await call()
    expect(res.status).toBe(500)
    expect(body).toEqual({ error: 'Failed to fetch discount usage' })
  })
})
