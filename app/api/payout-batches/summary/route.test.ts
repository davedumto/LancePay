import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from './route'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    payoutBatch: { groupBy: vi.fn() },
    payoutItem: { groupBy: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const USER = '11111111-1111-4111-8111-111111111111'

function request(query = '', token: string | null = 'user-token') {
  return new NextRequest(`http://localhost/api/payout-batches/summary${query}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockImplementation((async (token: string) =>
    token === 'user-token' ? { userId: 'privy-user' } : null) as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: USER, role: 'freelancer' } as any)
  vi.mocked(prisma.payoutBatch.groupBy).mockResolvedValue([
    { status: 'completed', _count: { _all: 3 } },
    { status: 'processing', _count: { _all: 1 } },
    { status: 'cancelled', _count: { _all: 2 } },
  ] as any)
  vi.mocked(prisma.payoutItem.groupBy).mockResolvedValue([
    { status: 'success', _sum: { amount: '1250.500000' } },
    { status: 'failed', _sum: { amount: '75.25' } },
  ] as any)
})

describe('GET /api/payout-batches/summary', () => {
  it('aggregates disbursed and failed totals and batch counts by status', async () => {
    const response = await GET(request())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      summary: {
        totalBatches: 6,
        countByStatus: { completed: 3, processing: 1, cancelled: 2 },
        totalDisbursedAmount: '1250.500000',
        totalFailedAmount: '75.250000',
      },
      filters: { from: null, to: null },
    })
  })

  it('scopes both aggregations to the authenticated user only', async () => {
    await GET(request())

    expect(prisma.payoutBatch.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER } }),
    )
    expect(prisma.payoutItem.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: { in: ['success', 'failed'] }, batch: { userId: USER } },
      }),
    )
  })

  it('applies the createdAt date range, treating a date-only "to" as end of day', async () => {
    const response = await GET(request('?from=2026-01-01&to=2026-01-31'))

    expect(response.status).toBe(200)
    const createdAt = {
      gte: new Date('2026-01-01T00:00:00.000Z'),
      lte: new Date('2026-01-31T23:59:59.999Z'),
    }
    expect(prisma.payoutBatch.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER, createdAt } }),
    )
    expect(vi.mocked(prisma.payoutItem.groupBy).mock.calls[0][0].where).toEqual({
      status: { in: ['success', 'failed'] },
      batch: { userId: USER, createdAt },
    })
    expect((await response.json()).filters).toEqual({
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-31T23:59:59.999Z',
    })
  })

  it('supports an open-ended range with only "from"', async () => {
    await GET(request('?from=2026-03-01T00:00:00Z'))

    expect(prisma.payoutBatch.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER, createdAt: { gte: new Date('2026-03-01T00:00:00Z') } } }),
    )
  })

  it('returns zeroed totals when the user has no batches', async () => {
    vi.mocked(prisma.payoutBatch.groupBy).mockResolvedValue([] as any)
    vi.mocked(prisma.payoutItem.groupBy).mockResolvedValue([] as any)

    const body = await (await GET(request())).json()

    expect(body.summary).toEqual({
      totalBatches: 0,
      countByStatus: {},
      totalDisbursedAmount: '0.000000',
      totalFailedAmount: '0.000000',
    })
  })

  it('rejects invalid or inverted date ranges', async () => {
    expect((await GET(request('?from=not-a-date'))).status).toBe(400)
    expect((await GET(request('?to=nope'))).status).toBe(400)
    expect((await GET(request('?from=2026-02-01&to=2026-01-01'))).status).toBe(400)
    expect(prisma.payoutBatch.groupBy).not.toHaveBeenCalled()
  })

  it('rejects unauthenticated requests', async () => {
    expect((await GET(request('', null))).status).toBe(401)
    expect((await GET(request('', 'bad-token'))).status).toBe(401)
  })

  it('returns 404 when the user record does not exist', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
    expect((await GET(request())).status).toBe(404)
  })

  it('returns 500 when the database fails', async () => {
    vi.mocked(prisma.payoutBatch.groupBy).mockRejectedValue(new Error('connection refused'))

    const response = await GET(request())

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Failed to load payout batch summary' })
  })
})
