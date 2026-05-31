import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const transactionAggregate = vi.fn()
const transactionFindMany = vi.fn()
const loggerError = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/logger', () => ({ logger: { error: loggerError } }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    transaction: {
      aggregate: transactionAggregate,
      findMany: transactionFindMany,
    },
  },
}))

vi.mock('../../app/api/routes-b/_lib/with-request-id', () => ({
  withRequestId: (handler: (req: NextRequest) => Promise<Response>) => handler,
}))

vi.mock('../../app/api/routes-b/_lib/with-compression', () => ({
  withCompression: (_req: NextRequest, res: any) => res,
}))

const URL = 'http://localhost/api/routes-b/analytics/earnings'

function makeRequest(
  params: Record<string, string> = {},
  headers: Record<string, string> = { authorization: 'Bearer token' },
): NextRequest {
  const url = new URL(BASE_URL)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return new NextRequest(url.toString(), { headers })
}

describe('GET /api/routes-d/analytics/earnings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when no auth token is provided', async () => {
    const { GET } = await import('@/app/api/routes-d/analytics/earnings/route')
    const response = await GET(makeRequest({}, {}))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: expect.any(String) })
    expect(userFindUnique).not.toHaveBeenCalled()
  })

  it('returns 401 when the auth token is invalid', async () => {
    verifyAuthToken.mockResolvedValue(null)

    const { GET } = await import('@/app/api/routes-d/analytics/earnings/route')
    const response = await GET(makeRequest())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: expect.any(String) })
    expect(userFindUnique).not.toHaveBeenCalled()
  })

  it('returns 401 when the user is not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(null)

    const { GET } = await import('@/app/api/routes-d/analytics/earnings/route')
    const response = await GET(makeRequest())

    expect(response.status).toBe(401)
  })

  it('returns 400 for an invalid period param', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })

    const { GET } = await import('@/app/api/routes-d/analytics/earnings/route')
    const response = await GET(makeRequest({ period: 'yearly' }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: expect.any(String) })
  })

  it('returns earnings with zero totals when no transactions exist', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    transactionAggregate.mockResolvedValue({ _sum: { amount: null } })
    transactionFindMany.mockResolvedValue([])

    const { GET } = await import('@/app/api/routes-d/analytics/earnings/route')
    const response = await GET(makeRequest())

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.earnings.totalEarned).toBe(0)
    expect(body.earnings.thisMonth).toBe(0)
    expect(body.earnings.lastMonth).toBe(0)
    expect(body.earnings.currency).toBe('USDC')
    expect(body.earnings.data).toEqual([])
  })

  it('defaults to monthly period when no period param is provided', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    transactionAggregate.mockResolvedValue({ _sum: { amount: '500.00' } })
    transactionFindMany.mockResolvedValue([])

    const { GET } = await import('@/app/api/routes-d/analytics/earnings/route')
    const response = await GET(makeRequest())

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.earnings.period).toBe('monthly')
  })

  it('accepts daily period and returns correct structure', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    transactionAggregate.mockResolvedValue({ _sum: { amount: '200.00' } })
    transactionFindMany.mockResolvedValue([
      { amount: '100.00', createdAt: new Date('2026-05-01T10:00:00Z') },
      { amount: '100.00', createdAt: new Date('2026-05-02T10:00:00Z') },
    ])

    const { GET } = await import('@/app/api/routes-d/analytics/earnings/route')
    const response = await GET(makeRequest({ period: 'daily' }))

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.earnings.period).toBe('daily')
    expect(Array.isArray(body.earnings.data)).toBe(true)
  })

  it('accepts weekly period and returns correct structure', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    transactionAggregate.mockResolvedValue({ _sum: { amount: '300.00' } })
    transactionFindMany.mockResolvedValue([])

    const { GET } = await import('@/app/api/routes-d/analytics/earnings/route')
    const response = await GET(makeRequest({ period: 'weekly' }))

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.earnings.period).toBe('weekly')
  })

  it('returns correct totalEarned from aggregate', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    transactionAggregate
      .mockResolvedValueOnce({ _sum: { amount: '1500.50' } }) // totalEarned
      .mockResolvedValueOnce({ _sum: { amount: '400.00' } })  // thisMonth
      .mockResolvedValueOnce({ _sum: { amount: '200.25' } })  // lastMonth
    transactionFindMany.mockResolvedValue([])

    const { GET } = await import('@/app/api/routes-d/analytics/earnings/route')
    const response = await GET(makeRequest())

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.earnings.totalEarned).toBe(1500.5)
    expect(body.earnings.thisMonth).toBe(400)
    expect(body.earnings.lastMonth).toBe(200.25)
  })

  it('groups monthly transactions into data points sorted by label', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    transactionAggregate.mockResolvedValue({ _sum: { amount: '300.00' } })
    transactionFindMany.mockResolvedValue([
      { amount: '100.00', createdAt: new Date('2026-03-15T00:00:00Z') },
      { amount: '50.00', createdAt: new Date('2026-03-20T00:00:00Z') },
      { amount: '150.00', createdAt: new Date('2026-04-10T00:00:00Z') },
    ])

    const { GET } = await import('@/app/api/routes-d/analytics/earnings/route')
    const response = await GET(makeRequest({ period: 'monthly' }))

    expect(response.status).toBe(200)
    const body = await response.json()
    const data: Array<{ period: string; amount: number }> = body.earnings.data
    expect(data.length).toBeGreaterThan(0)
    // Labels should be sorted ascending
    const labels = data.map((d) => d.period)
    expect(labels).toEqual([...labels].sort())
    // March bucket should sum both transactions
    const march = data.find((d) => d.period === '2026-03')
    expect(march?.amount).toBe(150)
  })

  it('queries only completed payment transactions', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    transactionAggregate.mockResolvedValue({ _sum: { amount: null } })
    transactionFindMany.mockResolvedValue([])

    const { GET } = await import('@/app/api/routes-d/analytics/earnings/route')
    await GET(makeRequest())

    expect(transactionAggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user_1',
          type: 'payment',
          status: 'completed',
        }),
      }),
    )
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
})
