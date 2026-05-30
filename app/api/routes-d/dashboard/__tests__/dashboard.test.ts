import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { groupBy: vi.fn() },
    transaction: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
  },
}))
vi.mock('@prisma/client', () => ({
  Prisma: {
    sql: (strings: unknown, ...values: unknown[]) => ({ strings, values }),
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET } from '../route'
import { clearDashboardCache } from '../../_shared/cache'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedGroupBy = vi.mocked(prisma.invoice.groupBy)
const mockedQueryRaw = vi.mocked(prisma.$queryRaw)
const mockedTxFind = vi.mocked(prisma.transaction.findMany)

function getReq(auth = 'Bearer token'): NextRequest {
  return new NextRequest('http://localhost/api/routes-d/dashboard', {
    method: 'GET',
    headers: auth ? { authorization: auth } : {},
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  clearDashboardCache()
  mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
  mockedUserFind.mockResolvedValue({ id: 'user-1' } as never)
  mockedGroupBy.mockResolvedValue([] as never)
  mockedQueryRaw.mockResolvedValue([{ totalEarned: 0, thisMonth: 0 }] as never)
  mockedTxFind.mockResolvedValue([] as never)
})

describe('GET /api/routes-d/dashboard', () => {
  it('returns 401 when authorization header is missing', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await GET(getReq(''))
    expect(res.status).toBe(401)
  })

  it('returns 401 for an invalid token', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await GET(getReq())
    expect(res.status).toBe(401)
  })

  it('returns 200 with a summary object on success', async () => {
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toHaveProperty('summary')
    expect(json.summary).toHaveProperty('invoices')
    expect(json.summary).toHaveProperty('earnings')
    expect(json.summary).toHaveProperty('recentTransactions')
  })

  it('returns zeroed invoice counts when no invoices exist', async () => {
    const res = await GET(getReq())
    const json = await res.json()
    expect(json.summary.invoices.total).toBe(0)
    expect(json.summary.invoices.pending).toBe(0)
    expect(json.summary.invoices.paid).toBe(0)
    expect(json.summary.invoices.overdue).toBe(0)
    expect(json.summary.invoices.cancelled).toBe(0)
  })

  it('aggregates invoice counts by status correctly', async () => {
    mockedGroupBy.mockResolvedValue([
      { status: 'pending', _count: { id: 3 } },
      { status: 'paid', _count: { id: 7 } },
      { status: 'overdue', _count: { id: 2 } },
    ] as never)

    const res = await GET(getReq())
    const json = await res.json()
    expect(json.summary.invoices.pending).toBe(3)
    expect(json.summary.invoices.paid).toBe(7)
    expect(json.summary.invoices.overdue).toBe(2)
    expect(json.summary.invoices.cancelled).toBe(0)
    expect(json.summary.invoices.total).toBe(12)
  })

  it('returns earnings from raw SQL and sets currency to USDC', async () => {
    mockedQueryRaw.mockResolvedValue([{ totalEarned: 1500, thisMonth: 300 }] as never)

    const res = await GET(getReq())
    const json = await res.json()
    expect(json.summary.earnings.totalEarned).toBe(1500)
    expect(json.summary.earnings.thisMonth).toBe(300)
    expect(json.summary.earnings.currency).toBe('USDC')
  })

  it('defaults earnings to zero when raw SQL returns empty array', async () => {
    mockedQueryRaw.mockResolvedValue([] as never)

    const res = await GET(getReq())
    const json = await res.json()
    expect(json.summary.earnings.totalEarned).toBe(0)
    expect(json.summary.earnings.thisMonth).toBe(0)
  })

  it('returns an empty recentTransactions array when no completed transactions exist', async () => {
    const res = await GET(getReq())
    const json = await res.json()
    expect(json.summary.recentTransactions).toEqual([])
  })

  it('returns up to 5 recent transactions with numeric amounts', async () => {
    const txs = Array.from({ length: 5 }, (_, i) => ({
      id: `tx-${i}`,
      type: 'payment',
      amount: '100.00',
      currency: 'USDC',
      createdAt: new Date().toISOString(),
    }))
    mockedTxFind.mockResolvedValue(txs as never)

    const res = await GET(getReq())
    const json = await res.json()
    expect(json.summary.recentTransactions).toHaveLength(5)
    expect(typeof json.summary.recentTransactions[0].amount).toBe('number')
  })

  it('ignores unknown invoice statuses in aggregation', async () => {
    mockedGroupBy.mockResolvedValue([
      { status: 'unknown_status', _count: { id: 5 } },
      { status: 'paid', _count: { id: 2 } },
    ] as never)

    const res = await GET(getReq())
    const json = await res.json()
    expect(json.summary.invoices.paid).toBe(2)
    expect(json.summary.invoices.total).toBe(7)
  })

  it('caches the dashboard response and returns it on subsequent requests', async () => {
    // 1st request
    const res1 = await GET(getReq())
    expect(res1.status).toBe(200)
    expect(prisma.invoice.groupBy).toHaveBeenCalledTimes(1)

    // Reset call counts
    vi.mocked(prisma.invoice.groupBy).mockClear()

    // 2nd request
    const res2 = await GET(getReq())
    expect(res2.status).toBe(200)
    expect(prisma.invoice.groupBy).toHaveBeenCalledTimes(0)
  })

  it('invalidates cache when cleared', async () => {
    // 1st request
    const res1 = await GET(getReq())
    expect(res1.status).toBe(200)
    expect(prisma.invoice.groupBy).toHaveBeenCalledTimes(1)

    // Clear cache
    clearDashboardCache()

    // Reset call counts
    vi.mocked(prisma.invoice.groupBy).mockClear()

    // 2nd request (should query database again)
    const res2 = await GET(getReq())
    expect(res2.status).toBe(200)
    expect(prisma.invoice.groupBy).toHaveBeenCalledTimes(1)
  })
})