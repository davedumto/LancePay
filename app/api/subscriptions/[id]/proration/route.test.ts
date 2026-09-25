import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { Decimal } from '@prisma/client/runtime/library'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    subscription: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { POST } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

// Current period: 2026-02-01 → 2026-03-01 (28 days, monthly).
const PERIOD_START = '2026-02-01T00:00:00.000Z'
const PERIOD_END = '2026-03-01T00:00:00.000Z'
const MIDPOINT = '2026-02-15T00:00:00.000Z'

function makeSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-1',
    amount: new Decimal('100.00'),
    currency: 'USD',
    frequency: 'monthly',
    interval: 1,
    status: 'active',
    nextGenerationDate: new Date(PERIOD_END),
    ...overrides,
  }
}

function makeRequest(body: unknown, token: string | null = 'token') {
  return new NextRequest('http://localhost/api/subscriptions/sub-1/proration', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function call(body: unknown, token: string | null = 'token') {
  const res = await POST(makeRequest(body, token), { params: Promise.resolve({ id: 'sub-1' }) })
  return { res, body: await res.json() }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' } as never)
  vi.mocked(prisma.subscription.findFirst).mockResolvedValue(makeSubscription() as never)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('POST /api/subscriptions/[id]/proration', () => {
  describe('authentication and access control', () => {
    it('returns 401 without a bearer token', async () => {
      const { res } = await call({ newAmount: 200 }, null)
      expect(res.status).toBe(401)
      expect(prisma.subscription.findFirst).not.toHaveBeenCalled()
    })

    it('returns 401 for an invalid token', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue(null as never)
      const { res } = await call({ newAmount: 200 })
      expect(res.status).toBe(401)
    })

    it('scopes the lookup to the owner and returns 404 for missing or foreign subscriptions', async () => {
      vi.mocked(prisma.subscription.findFirst).mockResolvedValue(null as never)
      const { res, body } = await call({ newAmount: 200, effectiveAt: MIDPOINT })
      expect(res.status).toBe(404)
      expect(body).toEqual({ error: 'Subscription not found' })
      expect(prisma.subscription.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'sub-1', userId: 'user-1' } }),
      )
    })
  })

  describe('request validation', () => {
    it('rejects malformed JSON', async () => {
      const { res, body } = await call('{not json')
      expect(res.status).toBe(400)
      expect(body).toEqual({ error: 'Invalid JSON body' })
    })

    it.each([undefined, 0, -10, '12.345', 'abc', null])('rejects newAmount=%s', async (newAmount) => {
      const { res, body } = await call({ newAmount, effectiveAt: MIDPOINT })
      expect(res.status).toBe(400)
      expect(body.error).toMatch(/newAmount/)
      expect(prisma.subscription.findFirst).not.toHaveBeenCalled()
    })

    it.each([123, 'not-a-date'])('rejects effectiveAt=%s', async (effectiveAt) => {
      const { res, body } = await call({ newAmount: 200, effectiveAt })
      expect(res.status).toBe(400)
      expect(body.error).toMatch(/effectiveAt/)
    })

    it('rejects a non-string currency', async () => {
      const { res } = await call({ newAmount: 200, effectiveAt: MIDPOINT, currency: 5 })
      expect(res.status).toBe(400)
    })
  })

  describe('business rules', () => {
    it('returns 422 CURRENCY_MISMATCH when the requested currency differs', async () => {
      const { res, body } = await call({ newAmount: 200, effectiveAt: MIDPOINT, currency: 'EUR' })
      expect(res.status).toBe(422)
      expect(body.code).toBe('CURRENCY_MISMATCH')
    })

    it('accepts a matching currency case-insensitively', async () => {
      const { res } = await call({ newAmount: 200, effectiveAt: MIDPOINT, currency: 'usd' })
      expect(res.status).toBe(200)
    })

    it.each(['paused', 'cancelled'])('returns 422 for a %s subscription', async (status) => {
      vi.mocked(prisma.subscription.findFirst).mockResolvedValue(makeSubscription({ status }) as never)
      const { res, body } = await call({ newAmount: 200, effectiveAt: MIDPOINT })
      expect(res.status).toBe(422)
      expect(body.code).toBe('SUBSCRIPTION_NOT_ACTIVE')
    })

    it('returns 422 for an unsupported billing frequency', async () => {
      vi.mocked(prisma.subscription.findFirst).mockResolvedValue(
        makeSubscription({ frequency: 'fortnightly' }) as never,
      )
      const { res, body } = await call({ newAmount: 200, effectiveAt: MIDPOINT })
      expect(res.status).toBe(422)
      expect(body.code).toBe('UNSUPPORTED_BILLING_PERIOD')
    })

    it.each(['2026-01-31T23:59:59.999Z', '2026-03-01T00:00:00.001Z'])(
      'returns 422 when effectiveAt %s is outside the billing period',
      async (effectiveAt) => {
        const { res, body } = await call({ newAmount: 200, effectiveAt })
        expect(res.status).toBe(422)
        expect(body.code).toBe('EFFECTIVE_DATE_OUTSIDE_BILLING_PERIOD')
      },
    )
  })

  describe('calculation', () => {
    it('upgrade mid-cycle produces a positive net charge', async () => {
      const { res, body } = await call({ newAmount: 200, effectiveAt: MIDPOINT })
      expect(res.status).toBe(200)
      expect(body).toEqual({
        subscriptionId: 'sub-1',
        currency: 'USD',
        direction: 'upgrade',
        currentAmount: 100,
        newAmount: 200,
        billingPeriod: { start: PERIOD_START, end: PERIOD_END },
        effectiveAt: MIDPOINT,
        remainingMs: 14 * 86_400_000,
        periodMs: 28 * 86_400_000,
        credit: 50,
        charge: 100,
        netAmount: 50,
        signConvention: expect.stringContaining('positive means the customer owes'),
      })
    })

    it('downgrade mid-cycle produces a negative net credit', async () => {
      const { body } = await call({ newAmount: '40.00', effectiveAt: MIDPOINT })
      expect(body.direction).toBe('downgrade')
      expect(body.credit).toBe(50)
      expect(body.charge).toBe(20)
      expect(body.netAmount).toBe(-30)
    })

    it('equal price nets to zero', async () => {
      const { body } = await call({ newAmount: 100, effectiveAt: MIDPOINT })
      expect(body.direction).toBe('none')
      expect(body.credit).toBe(50)
      expect(body.charge).toBe(50)
      expect(body.netAmount).toBe(0)
    })

    it('change at the start of the period uses the full period', async () => {
      const { body } = await call({ newAmount: 250, effectiveAt: PERIOD_START })
      expect(body.credit).toBe(100)
      expect(body.charge).toBe(250)
      expect(body.netAmount).toBe(150)
    })

    it('change at the end of the period prorates to zero', async () => {
      const { body } = await call({ newAmount: 250, effectiveAt: PERIOD_END })
      expect(body.remainingMs).toBe(0)
      expect(body.credit).toBe(0)
      expect(body.charge).toBe(0)
      expect(body.netAmount).toBe(0)
    })

    it('rounds components to cents and keeps the net consistent', async () => {
      vi.mocked(prisma.subscription.findFirst).mockResolvedValue(
        makeSubscription({
          amount: new Decimal('10.00'),
          nextGenerationDate: new Date('2026-05-01T00:00:00.000Z'),
        }) as never,
      )
      const { body } = await call({ newAmount: 20, effectiveAt: '2026-04-11T00:00:00.000Z' })
      expect(body.billingPeriod.start).toBe('2026-04-01T00:00:00.000Z')
      expect(body.credit).toBe(6.67)
      expect(body.charge).toBe(13.33)
      expect(body.netAmount).toBe(6.66)
    })

    it('defaults effectiveAt to the current time', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-02-22T00:00:00.000Z'))
      const { body } = await call({ newAmount: 200 })
      expect(body.effectiveAt).toBe('2026-02-22T00:00:00.000Z')
      expect(body.remainingMs).toBe(7 * 86_400_000)
      expect(body.netAmount).toBe(25)
    })

    it('does not modify the subscription', async () => {
      await call({ newAmount: 200, effectiveAt: MIDPOINT })
      expect(prisma.subscription.update).not.toHaveBeenCalled()
      expect(prisma.subscription.updateMany).not.toHaveBeenCalled()
    })
  })

  it('returns a generic 500 without leaking database errors', async () => {
    vi.mocked(prisma.subscription.findFirst).mockRejectedValue(new Error('db exploded'))
    const { res, body } = await call({ newAmount: 200, effectiveAt: MIDPOINT })
    expect(res.status).toBe(500)
    expect(body).toEqual({ error: 'Failed to calculate proration' })
  })
})
