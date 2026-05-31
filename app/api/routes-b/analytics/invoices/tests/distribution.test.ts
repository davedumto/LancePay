import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from '../route'
import { buildRequest } from '../../../_lib/test-helpers'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
    invoice: {
      groupBy: vi.fn(),
    },
  },
}))

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockedFindUnique = vi.mocked(prisma.user.findUnique)
const mockedGroupBy = vi.mocked(prisma.invoice.groupBy)
const mockedVerifyAuthToken = vi.mocked(verifyAuthToken)

describe('GET /api/routes-b/analytics/invoices', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedVerifyAuthToken.mockResolvedValue({ userId: 'user-1' } as any)
    mockedFindUnique.mockResolvedValue({ id: 'db-user-1' } as any)
  })

  it('handles all-zero user', async () => {
    mockedGroupBy.mockResolvedValue([])

    const req = buildRequest('GET', 'http://localhost/api/routes-b/analytics/invoices', { token: 'valid' })
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.invoices.total).toBe(0)
    expect(body.invoices.distribution.paid.count).toBe(0)
    expect(body.invoices.distribution.paid.percentage).toBe(0)
    expect(body.invoices.distribution.pending.percentage).toBe(0)
    expect(body.invoices.distribution.overdue.percentage).toBe(0)
    expect(body.invoices.distribution.cancelled.percentage).toBe(0)
  })

  it('handles mixed statuses', async () => {
    mockedGroupBy.mockResolvedValue([
      { status: 'paid', _count: { id: 2 }, _sum: { amount: 200 } },
      { status: 'pending', _count: { id: 2 }, _sum: { amount: 200 } },
    ] as any)

    const req = buildRequest('GET', 'http://localhost/api/routes-b/analytics/invoices', { token: 'valid' })
    const res = await GET(req)
    const body = await res.json()

    expect(body.invoices.total).toBe(4)
    expect(body.invoices.distribution.paid.count).toBe(2)
    expect(body.invoices.distribution.paid.percentage).toBe(50)
    expect(body.invoices.distribution.pending.count).toBe(2)
    expect(body.invoices.distribution.pending.percentage).toBe(50)
    expect(body.invoices.distribution.overdue.count).toBe(0)
    expect(body.invoices.distribution.overdue.percentage).toBe(0)
  })

  it('handles single status', async () => {
     mockedGroupBy.mockResolvedValue([
      { status: 'overdue', _count: { id: 10 }, _sum: { amount: 1000 } },
    ] as any)

    const req = buildRequest('GET', 'http://localhost/api/routes-b/analytics/invoices', { token: 'valid' })
    const res = await GET(req)
    const body = await res.json()

    expect(body.invoices.total).toBe(10)
    expect(body.invoices.distribution.overdue.percentage).toBe(100)
    expect(body.invoices.distribution.paid.percentage).toBe(0)
  })

  it('ensures percentages sum to 100 with tolerance', async () => {
    mockedGroupBy.mockResolvedValue([
      { status: 'paid', _count: { id: 1 }, _sum: { amount: 100 } },
      { status: 'pending', _count: { id: 1 }, _sum: { amount: 100 } },
      { status: 'overdue', _count: { id: 1 }, _sum: { amount: 100 } },
    ] as any)

    const req = buildRequest('GET', 'http://localhost/api/routes-b/analytics/invoices', { token: 'valid' })
    const res = await GET(req)
    const body = await res.json()

    const sum = 
      body.invoices.distribution.paid.percentage + 
      body.invoices.distribution.pending.percentage + 
      body.invoices.distribution.overdue.percentage + 
      body.invoices.distribution.cancelled.percentage

    expect(Math.abs(sum - 100)).toBeLessThanOrEqual(0.01)
  })
})
