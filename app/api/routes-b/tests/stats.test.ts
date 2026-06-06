import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from '../stats/route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
    invoice: {
      groupBy: vi.fn(),
    },
    transaction: {
      aggregate: vi.fn(),
      count: vi.fn(),
    },
  },
}))

// Mock cache
vi.mock('../_lib/cache', () => ({
  getCacheValue: vi.fn(),
  setCacheValue: vi.fn(),
}))

function makeReq(url: string) {
  return new NextRequest(url, {
    headers: { authorization: 'Bearer valid-token' },
  })
}

describe('Stats API (Period Parameters)', () => {
  const mockUser = { id: 'user-1', privyId: 'privy-1', role: 'user' }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
  })

  it('returns all-time stats when period is missing (backwards compatibility)', async () => {
    vi.mocked(prisma.invoice.groupBy).mockResolvedValue([
      { status: 'paid', _count: { id: 5 } },
      { status: 'pending', _count: { id: 2 } },
    ] as any)
    vi.mocked(prisma.transaction.aggregate).mockResolvedValue({ _sum: { amount: 1000 } } as any)
    vi.mocked(prisma.transaction.count).mockResolvedValue(1)

    const req = makeReq('http://localhost/api/routes-b/stats')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.invoices.paid).toBe(5)
    expect(body.invoices.pending).toBe(2)
    expect(body.totalEarned).toBe(1000)
    expect(body.period).toBeUndefined()
    
    // Verify no date filters were applied to prisma calls
    expect(prisma.invoice.groupBy).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'user-1' }
    }))
  })

  it('returns periodic stats with deltas when period=month is provided', async () => {
    // Mock current period
    vi.mocked(prisma.invoice.groupBy)
      .mockResolvedValueOnce([
        { status: 'paid', _count: { id: 10 } }, // Current
      ] as any)
      .mockResolvedValueOnce([
        { status: 'paid', _count: { id: 5 } },  // Previous
      ] as any)

    vi.mocked(prisma.transaction.aggregate)
      .mockResolvedValueOnce({ _sum: { amount: 200 } } as any) // Current
      .mockResolvedValueOnce({ _sum: { amount: 100 } } as any) // Previous

    vi.mocked(prisma.transaction.count)
      .mockResolvedValueOnce(2) // Current
      .mockResolvedValueOnce(1) // Previous

    const req = makeReq('http://localhost/api/routes-b/stats?period=month')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.period).toBe('month')
    expect(body.invoices.paid.current).toBe(10)
    expect(body.invoices.paid.previous).toBe(5)
    expect(body.invoices.paid.deltaPct).toBe(100)
    expect(body.totalEarned.deltaPct).toBe(100)
    expect(body.pendingWithdrawals.deltaPct).toBe(100)
    
    // Verify date filters were applied
    expect(prisma.invoice.groupBy).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        createdAt: expect.any(Object)
      })
    }))
  })

  it('defaults to month when period param is empty (?period=)', async () => {
    vi.mocked(prisma.invoice.groupBy).mockResolvedValue([])
    vi.mocked(prisma.transaction.aggregate).mockResolvedValue({ _sum: { amount: 0 } } as any)
    vi.mocked(prisma.transaction.count).mockResolvedValue(0)

    const req = makeReq('http://localhost/api/routes-b/stats?period=')
    const res = await GET(req)
    const body = await res.json()

    expect(body.period).toBe('month')
  })

  it('handles week boundaries and ISO weeks', async () => {
    // This is more of a test for the period helper, but we verify the route uses it correctly
    const req = makeReq('http://localhost/api/routes-b/stats?period=week')
    await GET(req)
    
    // Check that it made 2 sets of calls (current + previous)
    expect(prisma.invoice.groupBy).toHaveBeenCalledTimes(2)
  })
})
