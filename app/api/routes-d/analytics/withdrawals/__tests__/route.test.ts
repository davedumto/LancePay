import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    transaction: { aggregate: vi.fn(), count: vi.fn() },
  },
}))
vi.mock('@/lib/logger', () => ({
  logger: { child: vi.fn().mockReturnValue({ error: vi.fn(), info: vi.fn() }) },
  default: { child: vi.fn().mockReturnValue({ error: vi.fn(), info: vi.fn() }) },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedAggregate = vi.mocked(prisma.transaction.aggregate)
const mockedCount = vi.mocked(prisma.transaction.count)

function makeRequest(params: Record<string, string> = {}, auth = 'Bearer token'): NextRequest {
  const url = new URL('http://localhost/api/routes-d/analytics/withdrawals')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return new NextRequest(url.toString(), {
    method: 'GET',
    headers: auth ? { authorization: auth } : {},
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
  mockedUserFind.mockResolvedValue({ id: 'user-1' } as never)
  mockedAggregate
    .mockResolvedValueOnce({ _count: { id: 10 }, _sum: { amount: 5000 } } as never)
    .mockResolvedValueOnce({ _count: { id: 8 }, _sum: { amount: 4500 } } as never)
  mockedCount.mockResolvedValueOnce(1 as never).mockResolvedValueOnce(1 as never)
})

describe('GET /api/routes-d/analytics/withdrawals', () => {
  it('returns 401 when no auth header is provided', async () => {
    const req = new NextRequest('http://localhost/api/routes-d/analytics/withdrawals', {
      method: 'GET',
    })
    expect((await GET(req)).status).toBe(401)
  })

  it('returns 401 when token is invalid', async () => {
    mockedVerify.mockResolvedValue(null as never)
    expect((await GET(makeRequest())).status).toBe(401)
  })

  it('returns 404 when user is not found', async () => {
    mockedUserFind.mockResolvedValue(null as never)
    expect((await GET(makeRequest())).status).toBe(404)
  })

  it('returns 200 with correct withdrawal summary on happy path', async () => {
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)

    const json = await res.json()
    expect(json.withdrawals.totalCount).toBe(10)
    expect(json.withdrawals.totalAmount).toBe(5000)
    expect(json.withdrawals.completedCount).toBe(8)
    expect(json.withdrawals.completedAmount).toBe(4500)
    expect(json.withdrawals.pendingCount).toBe(1)
    expect(json.withdrawals.failedCount).toBe(1)
    expect(json.withdrawals.currency).toBe('USDC')
  })

  it('accepts optional from/to date range params', async () => {
    const res = await GET(makeRequest({ from: '2024-01-01', to: '2024-01-31' }))
    expect(res.status).toBe(200)
  })

  it('returns 400 for invalid from date', async () => {
    const res = await GET(makeRequest({ from: 'not-a-date' }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/invalid from date/i)
  })

  it('returns 400 for invalid to date', async () => {
    const res = await GET(makeRequest({ to: 'bad-date' }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/invalid to date/i)
  })

  it('returns 400 when from is after to', async () => {
    const res = await GET(makeRequest({ from: '2024-02-01', to: '2024-01-01' }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/from must be before/i)
  })

  it('handles zero amounts gracefully', async () => {
    vi.resetAllMocks()
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFind.mockResolvedValue({ id: 'user-1' } as never)
    mockedAggregate
      .mockResolvedValueOnce({ _count: { id: 0 }, _sum: { amount: null } } as never)
      .mockResolvedValueOnce({ _count: { id: 0 }, _sum: { amount: null } } as never)
    mockedCount.mockResolvedValue(0 as never)

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.withdrawals.totalAmount).toBe(0)
    expect(json.withdrawals.completedAmount).toBe(0)
  })

  it('returns 500 on unexpected database error', async () => {
    mockedAggregate.mockReset()
    mockedAggregate.mockRejectedValue(new Error('DB failure') as never)
    const res = await GET(makeRequest())
    expect(res.status).toBe(500)
  })
})
