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

const URL = 'http://localhost/api/routes-b/analytics/earnings'

function makeRequest(
  params: Record<string, string> = {},
  headers: Record<string, string> = { authorization: 'Bearer token' },
) {
  const url = new URL(URL)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return new NextRequest(url.toString(), { headers })
}

describe('GET /api/routes-b/analytics/earnings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when no auth token is provided', async () => {
    const { GET } = await import('@/app/api/routes-b/analytics/earnings/route')
    const response = await GET(makeRequest({}, {}))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: expect.any(String) })
    expect(userFindUnique).not.toHaveBeenCalled()
  })

  it('returns 401 when the auth token is invalid', async () => {
    verifyAuthToken.mockResolvedValue(null)

    const { GET } = await import('@/app/api/routes-b/analytics/earnings/route')
    const response = await GET(makeRequest())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: expect.any(String) })
    expect(userFindUnique).not.toHaveBeenCalled()
  })

  it('returns 404 when the user is not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(null)

    const { GET } = await import('@/app/api/routes-b/analytics/earnings/route')
    const response = await GET(makeRequest())

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ error: expect.any(String) })
  })

  it('returns earnings summary with zero when no transactions exist', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1', timezone: 'UTC' })
    transactionAggregate.mockResolvedValue({ _sum: { amount: null } })

    const { GET } = await import('@/app/api/routes-b/analytics/earnings/route')
    const response = await GET(makeRequest())

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toHaveProperty('earnings')
    expect(body.earnings.totalEarned).toBe(0)
    expect(body.earnings.currency).toBe('USDC')
  })

  it('returns correct totalEarned when transactions exist', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1', timezone: 'UTC' })
    transactionAggregate.mockResolvedValue({ _sum: { amount: '500.75' } })

    const { GET } = await import('@/app/api/routes-b/analytics/earnings/route')
    const response = await GET(makeRequest())

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.earnings.totalEarned).toBe(500.75)
    expect(body.earnings.currency).toBe('USDC')
  })

  it('returns 400 for an invalid date format', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1', timezone: 'UTC' })

    const { GET } = await import('@/app/api/routes-b/analytics/earnings/route')
    const response = await GET(makeRequest({ from: 'not-a-date' }))

    expect(response.status).toBe(400)
  })

  it('returns earnings with from/to/days/tz fields', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1', timezone: 'UTC' })
    transactionAggregate.mockResolvedValue({ _sum: { amount: '1200.00' } })

    const { GET } = await import('@/app/api/routes-b/analytics/earnings/route')
    const response = await GET(makeRequest({ from: '2025-01-01', to: '2025-01-31' }))

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.earnings).toMatchObject({
      totalEarned: 1200,
      currency: 'USDC',
      from: expect.any(String),
      to: expect.any(String),
      days: expect.any(Number),
      tz: 'UTC',
    })
  })
})
