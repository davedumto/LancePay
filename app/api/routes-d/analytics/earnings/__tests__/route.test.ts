import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ── Mocks (must be declared before imports) ──────────────────────────
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    transaction: { aggregate: vi.fn(), findMany: vi.fn() },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

// ── Imports (after mocks) ────────────────────────────────────────────
import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET } from '../route'

// ── Typed mock references ────────────────────────────────────────────
const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedAggregate = vi.mocked(prisma.transaction.aggregate)
const mockedFindMany = vi.mocked(prisma.transaction.findMany)

// ── Request factory ──────────────────────────────────────────────────
const BASE_URL = 'http://localhost/api/routes-d/analytics/earnings'

function makeRequest(
  params: Record<string, string> = {},
  auth: string | null = 'Bearer token',
): NextRequest {
  const url = new URL(BASE_URL)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  return new NextRequest(url.toString(), {
    method: 'GET',
    headers: auth ? { authorization: auth } : {},
  })
}

// ── Default happy-path mocks ─────────────────────────────────────────
// Use mockResolvedValue (persistent) so individual tests can override with
// mockResolvedValueOnce without fighting a pre-queued sequence.
beforeEach(() => {
  vi.resetAllMocks()

  mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
  mockedUserFind.mockResolvedValue({ id: 'user-1' } as never)

  // Default: aggregate always returns the same happy-path values.
  // Tests that need specific per-call values should call vi.mocked(prisma.transaction.aggregate)
  // .mockReset() then re-queue with mockResolvedValueOnce.
  mockedAggregate.mockResolvedValue({ _sum: { amount: 5000 } } as never)

  mockedFindMany.mockResolvedValue([] as never)
})

// ── Auth tests ───────────────────────────────────────────────────────
describe('GET /api/routes-d/analytics/earnings — auth', () => {
  it('returns 401 when the Authorization header is missing', async () => {
    const res = await GET(makeRequest({}, null))
    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' })
  })

  it('returns 401 when the token is invalid', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' })
  })

  it('returns 401 when the user is not found in the database', async () => {
    mockedUserFind.mockResolvedValue(null as never)
    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' })
  })
})

// ── Validation tests ─────────────────────────────────────────────────
describe('GET /api/routes-d/analytics/earnings — validation', () => {
  it('returns 400 for an unrecognised period value', async () => {
    const res = await GET(makeRequest({ period: 'yearly' }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/invalid period/i)
    expect(body.error).toContain('daily')
    expect(body.error).toContain('weekly')
    expect(body.error).toContain('monthly')
  })

  it('accepts "daily" as a valid period', async () => {
    const res = await GET(makeRequest({ period: 'daily' }))
    expect(res.status).toBe(200)
  })

  it('accepts "weekly" as a valid period', async () => {
    const res = await GET(makeRequest({ period: 'weekly' }))
    expect(res.status).toBe(200)
  })

  it('accepts "monthly" as a valid period', async () => {
    const res = await GET(makeRequest({ period: 'monthly' }))
    expect(res.status).toBe(200)
  })

  it('defaults to "monthly" when no period param is supplied', async () => {
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.earnings.period).toBe('monthly')
  })
})

// ── Happy-path response shape ────────────────────────────────────────
describe('GET /api/routes-d/analytics/earnings — happy path', () => {
  it('returns the correct response envelope with distinct per-period values', async () => {
    // Override with per-call sequence: totalEarned → thisMonth → lastMonth
    mockedAggregate
      .mockResolvedValueOnce({ _sum: { amount: 5000 } } as never)
      .mockResolvedValueOnce({ _sum: { amount: 1200 } } as never)
      .mockResolvedValueOnce({ _sum: { amount: 800 } } as never)

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('earnings')
    expect(body.earnings).toMatchObject({
      totalEarned: 5000,
      thisMonth: 1200,
      lastMonth: 800,
      currency: 'USDC',
      period: 'monthly',
    })
    expect(Array.isArray(body.earnings.data)).toBe(true)
  })

  it('converts Prisma Decimal string values to numbers', async () => {
    mockedAggregate
      .mockResolvedValueOnce({ _sum: { amount: '9999.99' } } as never)
      .mockResolvedValueOnce({ _sum: { amount: '1234.56' } } as never)
      .mockResolvedValueOnce({ _sum: { amount: '567.89' } } as never)

    const res = await GET(makeRequest())
    const body = await res.json()
    expect(typeof body.earnings.totalEarned).toBe('number')
    expect(typeof body.earnings.thisMonth).toBe('number')
    expect(typeof body.earnings.lastMonth).toBe('number')
    expect(body.earnings.totalEarned).toBeCloseTo(9999.99)
  })

  it('returns zero amounts when aggregate _sum.amount is null', async () => {
    mockedAggregate.mockResolvedValue({ _sum: { amount: null } } as never)

    const res = await GET(makeRequest())
    const body = await res.json()
    expect(body.earnings.totalEarned).toBe(0)
    expect(body.earnings.thisMonth).toBe(0)
    expect(body.earnings.lastMonth).toBe(0)
  })

  it('returns an empty data array when no transactions exist in the window', async () => {
    mockedFindMany.mockResolvedValue([] as never)
    const res = await GET(makeRequest())
    const body = await res.json()
    expect(body.earnings.data).toEqual([])
  })
})

// ── Time-series grouping ─────────────────────────────────────────────
describe('GET /api/routes-d/analytics/earnings — time-series data', () => {
  it('groups transactions by month and returns sorted data points', async () => {
    mockedFindMany.mockResolvedValue([
      { amount: '300', createdAt: new Date('2026-03-15T10:00:00Z') },
      { amount: '200', createdAt: new Date('2026-03-20T10:00:00Z') },
      { amount: '500', createdAt: new Date('2026-04-05T10:00:00Z') },
    ] as never)

    const res = await GET(makeRequest({ period: 'monthly' }))
    const body = await res.json()
    const data: Array<{ period: string; amount: number }> = body.earnings.data

    // March entries should be merged
    const march = data.find((d) => d.period === '2026-03')
    expect(march).toBeDefined()
    expect(march!.amount).toBeCloseTo(500)

    // April entry
    const april = data.find((d) => d.period === '2026-04')
    expect(april).toBeDefined()
    expect(april!.amount).toBeCloseTo(500)

    // Data must be sorted ascending
    const labels = data.map((d) => d.period)
    expect(labels).toEqual([...labels].sort())
  })

  it('groups transactions by day for the daily period', async () => {
    mockedFindMany.mockResolvedValue([
      { amount: '100', createdAt: new Date('2026-05-01T08:00:00Z') },
      { amount: '150', createdAt: new Date('2026-05-01T18:00:00Z') },
      { amount: '200', createdAt: new Date('2026-05-02T09:00:00Z') },
    ] as never)

    const res = await GET(makeRequest({ period: 'daily' }))
    const body = await res.json()
    const data: Array<{ period: string; amount: number }> = body.earnings.data

    const may1 = data.find((d) => d.period === '2026-05-01')
    expect(may1).toBeDefined()
    expect(may1!.amount).toBeCloseTo(250) // 100 + 150

    const may2 = data.find((d) => d.period === '2026-05-02')
    expect(may2).toBeDefined()
    expect(may2!.amount).toBeCloseTo(200)
  })

  it('groups transactions by ISO week for the weekly period', async () => {
    mockedFindMany.mockResolvedValue([
      // Both dates fall in ISO week 2026-W18 (Mon 27 Apr – Sun 3 May 2026)
      { amount: '400', createdAt: new Date('2026-04-27T10:00:00Z') },
      { amount: '600', createdAt: new Date('2026-05-01T10:00:00Z') },
    ] as never)

    const res = await GET(makeRequest({ period: 'weekly' }))
    const body = await res.json()
    const data: Array<{ period: string; amount: number }> = body.earnings.data

    expect(data).toHaveLength(1)
    expect(data[0].period).toMatch(/^\d{4}-W\d{2}$/)
    expect(data[0].amount).toBeCloseTo(1000)
  })

  it('each data point has a numeric amount', async () => {
    mockedFindMany.mockResolvedValue([
      { amount: '750.50', createdAt: new Date('2026-01-10T00:00:00Z') },
    ] as never)

    const res = await GET(makeRequest({ period: 'monthly' }))
    const body = await res.json()
    expect(typeof body.earnings.data[0].amount).toBe('number')
  })
})

// ── Error handling ───────────────────────────────────────────────────
describe('GET /api/routes-d/analytics/earnings — error handling', () => {
  it('returns 500 when a database query throws', async () => {
    // Override the persistent mock so every aggregate call rejects
    mockedAggregate.mockRejectedValue(new Error('DB connection lost') as never)
    const res = await GET(makeRequest())
    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({ error: 'Failed to get earnings' })
  })

  it('returns 500 when findMany throws', async () => {
    mockedFindMany.mockRejectedValue(new Error('Timeout') as never)
    const res = await GET(makeRequest())
    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({ error: 'Failed to get earnings' })
  })
})
