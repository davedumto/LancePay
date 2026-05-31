import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/db', () => ({
  prisma: {
    invoice: {
      groupBy: vi.fn(),
    },
    transaction: {
      aggregate: vi.fn(),
      findMany: vi.fn(),
    },
  },
}))

import { prisma } from '@/lib/db'
import { buildDashboardSummary } from '../../_lib/aggregations'

const mockGroupBy = vi.mocked(prisma.invoice.groupBy)
const mockAggregate = vi.mocked(prisma.transaction.aggregate)
const mockFindMany = vi.mocked(prisma.transaction.findMany)

const ZERO_SUM = { _sum: { amount: null } }
const EMPTY_TXNS: never[] = []

function setupMocks() {
  mockGroupBy.mockResolvedValue([])
  mockAggregate.mockResolvedValue(ZERO_SUM as never)
  mockFindMany.mockResolvedValue(EMPTY_TXNS)
}

describe('buildDashboardSummary — query count is bounded', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    setupMocks()
  })

  it('executes exactly 4 database queries regardless of data volume', async () => {
    const result = await buildDashboardSummary('user-1')

    // queryCount tracks each prisma call inside the function
    expect(result.queryCount).toBe(4)
  })

  it('batches all queries concurrently (no sequential N+1)', async () => {
    let concurrentCallCount = 0
    let maxConcurrent = 0
    let active = 0

    const track = <T>(mock: ReturnType<typeof vi.fn>, value: T) => {
      mock.mockImplementation(() => {
        active++
        concurrentCallCount++
        maxConcurrent = Math.max(maxConcurrent, active)
        return Promise.resolve(value).then(v => { active--; return v })
      })
    }

    track(mockGroupBy, [])
    track(mockAggregate, ZERO_SUM)
    track(mockFindMany, EMPTY_TXNS)

    await buildDashboardSummary('user-1')

    // All 4 queries should have been kicked off concurrently (maxConcurrent >= 4)
    expect(maxConcurrent).toBeGreaterThanOrEqual(4)
    expect(concurrentCallCount).toBe(4)
  })

  it('returns well-structured summary with zero values when no data exists', async () => {
    const result = await buildDashboardSummary('user-1')

    expect(result.summary.invoices).toEqual({
      total: 0,
      pending: 0,
      paid: 0,
      overdue: 0,
      cancelled: 0,
    })
    expect(result.summary.earnings.totalEarned).toBe(0)
    expect(result.summary.earnings.thisMonth).toBe(0)
    expect(result.summary.earnings.currency).toBe('USDC')
    expect(result.summary.recentTransactions).toEqual([])
  })

  it('aggregates invoice status counts from groupBy result', async () => {
    mockGroupBy.mockResolvedValue([
      { status: 'pending', _count: { id: 5 } },
      { status: 'paid', _count: { id: 12 } },
      { status: 'overdue', _count: { id: 3 } },
    ] as never)

    const result = await buildDashboardSummary('user-1')

    expect(result.summary.invoices.pending).toBe(5)
    expect(result.summary.invoices.paid).toBe(12)
    expect(result.summary.invoices.overdue).toBe(3)
    expect(result.summary.invoices.cancelled).toBe(0)
    expect(result.summary.invoices.total).toBe(20)
  })

  it('sums earnings correctly from transaction aggregates', async () => {
    mockAggregate
      .mockResolvedValueOnce({ _sum: { amount: '1500.50' } } as never) // totalEarned
      .mockResolvedValueOnce({ _sum: { amount: '300.00' } } as never)  // thisMonth

    const result = await buildDashboardSummary('user-1')

    expect(result.summary.earnings.totalEarned).toBe(1500.5)
    expect(result.summary.earnings.thisMonth).toBe(300)
  })

  it('returns at most 5 recent transactions', async () => {
    const txns = Array.from({ length: 5 }, (_, i) => ({
      id: `tx-${i}`,
      type: 'payment',
      amount: 100,
      currency: 'USDC',
      createdAt: new Date(),
    }))
    mockFindMany.mockResolvedValue(txns as never)

    const result = await buildDashboardSummary('user-1')

    expect(result.summary.recentTransactions).toHaveLength(5)
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5 }),
    )
  })
})
