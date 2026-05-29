import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const transactionAggregate = vi.fn()
const loggerError = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/logger', () => ({ logger: { error: loggerError } }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    transaction: { aggregate: transactionAggregate },
  },
}))

vi.mock('../../app/api/routes-b/_lib/with-request-id', () => ({
  withRequestId: (handler: Function) => handler,
}))

vi.mock('../../app/api/routes-b/_lib/with-compression', () => ({
  withCompression: (_req: NextRequest, res: any) => res,
}))

const URL = 'http://localhost/api/routes-b/analytics/earnings'

function reqGET(query = '', auth = 'Bearer token'): NextRequest {
  return new NextRequest(`${URL}${query}`, {
    method: 'GET',
    headers: auth ? { authorization: auth } : {},
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  verifyAuthToken.mockResolvedValue({ userId: 'privy-1' } as never)
  userFindUnique.mockResolvedValue({ id: 'user-1', timezone: 'UTC' } as never)
})

describe('GET /api/routes-b/analytics/earnings', () => {
  it('returns 401 without token', async () => {
    verifyAuthToken.mockResolvedValue(null as never)
    const { GET } = await import('@/app/api/routes-b/analytics/earnings/route')
    expect((await GET(reqGET('', ''))).status).toBe(401)
  })

  it('returns 404 if user not found', async () => {
    userFindUnique.mockResolvedValue(null as never)
    const { GET } = await import('@/app/api/routes-b/analytics/earnings/route')
    expect((await GET(reqGET())).status).toBe(404)
  })

  it('returns 400 for invalid from date format', async () => {
    const { GET } = await import('@/app/api/routes-b/analytics/earnings/route')
    const res = await GET(reqGET('?from=invalid-date'))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe('Invalid date range')
  })

  it('returns 400 for invalid to date format', async () => {
    const { GET } = await import('@/app/api/routes-b/analytics/earnings/route')
    const res = await GET(reqGET('?to=invalid-date'))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe('Invalid date range')
  })

  it('returns 400 for date range exceeding 365 days', async () => {
    const { GET } = await import('@/app/api/routes-b/analytics/earnings/route')
    const res = await GET(reqGET('?from=2025-01-01&to=2027-01-01'))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe('Date range too large')
  })

  it('returns earnings for empty results', async () => {
    transactionAggregate.mockResolvedValue({ _sum: { amount: null } })
    const { GET } = await import('@/app/api/routes-b/analytics/earnings/route')
    const res = await GET(reqGET('?from=2026-05-01&to=2026-05-02'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.earnings.totalEarned).toBe(0)
    expect(json.earnings.currency).toBe('USDC')
    expect(json.earnings.from).toBeDefined()
    expect(json.earnings.to).toBeDefined()
  })

  it('returns single-day earnings correctly', async () => {
    const singleDayAmount = 150.75
    transactionAggregate.mockResolvedValue({ _sum: { amount: singleDayAmount } })

    const { GET } = await import('@/app/api/routes-b/analytics/earnings/route')
    const res = await GET(reqGET('?from=2026-05-15&to=2026-05-16'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.earnings.totalEarned).toBe(singleDayAmount)
    expect(json.earnings.days).toBe(1)
  })

  it('aggregates transactions correctly for multi-day range', async () => {
    const totalAmount = 1000.5
    transactionAggregate.mockResolvedValue({ _sum: { amount: totalAmount } })

    const { GET } = await import('@/app/api/routes-b/analytics/earnings/route')
    const res = await GET(reqGET('?from=2026-05-01&to=2026-05-31'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.earnings.totalEarned).toBe(totalAmount)
    expect(json.earnings.currency).toBe('USDC')
  })

  it('handles currency rounding boundaries correctly', async () => {
    const preciseAmount = 99.999999
    transactionAggregate.mockResolvedValue({ _sum: { amount: preciseAmount } })

    const { GET } = await import('@/app/api/routes-b/analytics/earnings/route')
    const res = await GET(reqGET('?from=2026-05-01&to=2026-05-02'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(typeof json.earnings.totalEarned).toBe('number')
  })

  it('converts BigInt amount to number correctly', async () => {
    const largeAmount = BigInt('999999999999')
    transactionAggregate.mockResolvedValue({ _sum: { amount: largeAmount } })

    const { GET } = await import('@/app/api/routes-b/analytics/earnings/route')
    const res = await GET(reqGET('?from=2026-05-01&to=2026-05-02'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.earnings.totalEarned).toBe(Number(largeAmount))
  })

  it('respects user timezone for date boundaries', async () => {
    userFindUnique.mockResolvedValue({ id: 'user-1', timezone: 'America/New_York' } as never)
    transactionAggregate.mockResolvedValue({ _sum: { amount: 100 } })

    const { GET } = await import('@/app/api/routes-b/analytics/earnings/route')
    const res = await GET(reqGET('?from=2026-05-15&to=2026-05-16'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.earnings.tz).toBe('America/New_York')
  })

  it('filters transactions by completed payments only', async () => {
    transactionAggregate.mockResolvedValue({ _sum: { amount: 500 } })

    const { GET } = await import('@/app/api/routes-b/analytics/earnings/route')
    await GET(reqGET('?from=2026-05-01&to=2026-05-31'))

    expect(transactionAggregate).toHaveBeenCalledWith({
      where: expect.objectContaining({
        userId: 'user-1',
        type: 'payment',
        status: 'completed',
      }),
      _sum: { amount: true },
    })
  })

  it('handles zero earnings correctly', async () => {
    transactionAggregate.mockResolvedValue({ _sum: { amount: 0 } })

    const { GET } = await import('@/app/api/routes-b/analytics/earnings/route')
    const res = await GET(reqGET('?from=2026-05-01&to=2026-05-02'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.earnings.totalEarned).toBe(0)
  })

  it('returns correctly formatted date range in user timezone', async () => {
    transactionAggregate.mockResolvedValue({ _sum: { amount: 100 } })

    const { GET } = await import('@/app/api/routes-b/analytics/earnings/route')
    const res = await GET(reqGET('?from=2026-05-01&to=2026-05-31'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.earnings.from).toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/)
    expect(json.earnings.to).toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/)
  })

  it('defaults to current month when no dates provided', async () => {
    transactionAggregate.mockResolvedValue({ _sum: { amount: 250 } })

    const { GET } = await import('@/app/api/routes-b/analytics/earnings/route')
    const res = await GET(reqGET())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.earnings.totalEarned).toBe(250)
    expect(json.earnings.days).toBeGreaterThan(0)
  })
})
