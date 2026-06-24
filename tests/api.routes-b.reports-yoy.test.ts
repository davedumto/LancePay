import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const transactionFindMany = vi.fn()
const loggerError = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/logger', () => ({ logger: { error: loggerError } }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    transaction: { findMany: transactionFindMany },
  },
}))

const BASE_URL = 'http://localhost/api/routes-b/reports/yoy'

function makeRequest(params: Record<string, string> = {}) {
  const url = new URL(BASE_URL)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return new NextRequest(url.toString(), {
    headers: { authorization: 'Bearer token' },
  })
}

describe('GET /api/routes-b/reports/yoy', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 for unauthenticated requests', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-b/reports/yoy/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
  })

  it('returns 404 when user is not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-b/reports/yoy/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(404)
  })

  it('returns 400 for invalid year parameter', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { GET } = await import('@/app/api/routes-b/reports/yoy/route')
    const res = await GET(makeRequest({ year: 'invalid' }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/Invalid year/)
  })

  it('returns 400 for year out of range', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { GET } = await import('@/app/api/routes-b/reports/yoy/route')
    const res = await GET(makeRequest({ year: '1999' }))
    expect(res.status).toBe(400)
  })

  it('defaults to current year when no year parameter is provided', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    transactionFindMany.mockResolvedValue([])
    const { GET } = await import('@/app/api/routes-b/reports/yoy/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.year).toBe(new Date().getFullYear())
  })

  it('returns zero totals when no transactions exist', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    transactionFindMany.mockResolvedValue([])
    const { GET } = await import('@/app/api/routes-b/reports/yoy/route')
    const res = await GET(makeRequest({ year: '2026' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.currentYearTotal).toBe(0)
    expect(json.previousYearTotal).toBe(0)
    expect(json.percentageChange).toBe(0)
    expect(json.currency).toBe('USDC')
  })

  it('calculates correct totals from transactions', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    transactionFindMany
      .mockResolvedValueOnce([
        { amount: '100.00', createdAt: new Date('2026-01-15') },
        { amount: '200.00', createdAt: new Date('2026-06-20') },
      ])
      .mockResolvedValueOnce([
        { amount: '50.00', createdAt: new Date('2025-03-10') },
        { amount: '75.00', createdAt: new Date('2025-08-05') },
      ])
    const { GET } = await import('@/app/api/routes-b/reports/yoy/route')
    const res = await GET(makeRequest({ year: '2026' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.currentYearTotal).toBe(300)
    expect(json.previousYearTotal).toBe(125)
    expect(json.percentageChange).toBe(140)
  })

  it('calculates percentage change correctly', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    transactionFindMany
      .mockResolvedValueOnce([{ amount: '150.00', createdAt: new Date('2026-01-01') }])
      .mockResolvedValueOnce([{ amount: '100.00', createdAt: new Date('2025-01-01') }])
    const { GET } = await import('@/app/api/routes-b/reports/yoy/route')
    const res = await GET(makeRequest({ year: '2026' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.percentageChange).toBe(50)
  })

  it('returns 100% change when previous year had no transactions', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    transactionFindMany
      .mockResolvedValueOnce([{ amount: '100.00', createdAt: new Date('2026-01-01') }])
      .mockResolvedValueOnce([])
    const { GET } = await import('@/app/api/routes-b/reports/yoy/route')
    const res = await GET(makeRequest({ year: '2026' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.percentageChange).toBe(100)
  })

  it('returns monthly comparison data', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    transactionFindMany.mockResolvedValue([])
    const { GET } = await import('@/app/api/routes-b/reports/yoy/route')
    const res = await GET(makeRequest({ year: '2026' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.monthlyComparison).toHaveLength(12)
    expect(json.monthlyComparison[0]).toHaveProperty('month')
    expect(json.monthlyComparison[0]).toHaveProperty('currentYearAmount')
    expect(json.monthlyComparison[0]).toHaveProperty('previousYearAmount')
    expect(json.monthlyComparison[0]).toHaveProperty('percentageChange')
  })

  it('queries only completed payment transactions', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    transactionFindMany.mockResolvedValue([])
    const { GET } = await import('@/app/api/routes-b/reports/yoy/route')
    await GET(makeRequest({ year: '2026' }))
    expect(transactionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user_1',
          type: 'payment',
          status: 'completed',
        }),
      }),
    )
  })

  it('filters transactions by correct date ranges', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    transactionFindMany.mockResolvedValue([])
    const { GET } = await import('@/app/api/routes-b/reports/yoy/route')
    await GET(makeRequest({ year: '2026' }))
    expect(transactionFindMany).toHaveBeenCalledTimes(2)
    expect(transactionFindMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: expect.objectContaining({
            gte: new Date('2026-01-01T00:00:00Z'),
            lt: new Date('2027-01-01T00:00:00Z'),
          }),
        }),
      }),
    )
    expect(transactionFindMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: expect.objectContaining({
            gte: new Date('2025-01-01T00:00:00Z'),
            lt: new Date('2026-01-01T00:00:00Z'),
          }),
        }),
      }),
    )
  })
})
