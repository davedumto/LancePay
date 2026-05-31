import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { groupBy: vi.fn() },
    transaction: { aggregate: vi.fn(), count: vi.fn() },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedGroupBy = vi.mocked(prisma.invoice.groupBy)
const mockedAggregate = vi.mocked(prisma.transaction.aggregate)
const mockedCount = vi.mocked(prisma.transaction.count)

function makeRequest(auth = 'Bearer token'): NextRequest {
  return new NextRequest('http://localhost/api/routes-d/stats', {
    method: 'GET',
    headers: auth ? { authorization: auth } : {},
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
  mockedUserFind.mockResolvedValue({ id: 'user-1' } as never)
  mockedGroupBy.mockResolvedValue([
    { status: 'pending', _count: { id: 3 } },
    { status: 'paid', _count: { id: 5 } },
    { status: 'cancelled', _count: { id: 1 } },
  ] as never)
  mockedAggregate.mockResolvedValue({ _sum: { amount: 1250 } } as never)
  mockedCount.mockResolvedValue(2 as never)
})

describe('GET /api/routes-d/stats', () => {
  it('returns 401 without auth header', async () => {
    const req = new NextRequest('http://localhost/api/routes-d/stats', { method: 'GET' })
    expect((await GET(req)).status).toBe(401)
  })

  it('returns 401 when token is invalid', async () => {
    mockedVerify.mockResolvedValue(null as never)
    expect((await GET(makeRequest())).status).toBe(401)
  })

  it('returns 401 when user not found', async () => {
    mockedUserFind.mockResolvedValue(null as never)
    expect((await GET(makeRequest())).status).toBe(401)
  })

  it('returns correct invoice counts', async () => {
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)

    const json = await res.json()
    expect(json.invoices.total).toBe(9)
    expect(json.invoices.pending).toBe(3)
    expect(json.invoices.paid).toBe(5)
    expect(json.invoices.cancelled).toBe(1)
    expect(json.invoices.overdue).toBe(0)
  })

  it('returns totalEarned from completed payments', async () => {
    const res = await GET(makeRequest())
    const json = await res.json()
    expect(json.totalEarned).toBe(1250)
  })

  it('returns pendingWithdrawals count', async () => {
    const res = await GET(makeRequest())
    const json = await res.json()
    expect(json.pendingWithdrawals).toBe(2)
  })

  it('handles zero earnings gracefully', async () => {
    mockedAggregate.mockResolvedValue({ _sum: { amount: null } } as never)
    const res = await GET(makeRequest())
    const json = await res.json()
    expect(json.totalEarned).toBe(0)
  })

  it('returns 500 on unexpected error', async () => {
    mockedGroupBy.mockRejectedValue(new Error('DB error') as never)
    const res = await GET(makeRequest())
    expect(res.status).toBe(500)
  })
})
