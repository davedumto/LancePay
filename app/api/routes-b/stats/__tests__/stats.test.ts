import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { groupBy: vi.fn() },
    transaction: { aggregate: vi.fn(), count: vi.fn() },
  },
}))

vi.mock('../../_lib/authz', () => ({
  requireScope: vi.fn(),
  RoutesBForbiddenError: class RoutesBForbiddenError extends Error {
    code = 'FORBIDDEN'
  },
}))

vi.mock('../../_lib/stats-cache', () => ({
  ensureStatsCacheInvalidationHooks: vi.fn(),
  getCachedStats: vi.fn(),
  setCachedStats: vi.fn(),
}))

vi.mock('../../_lib/with-compression', () => ({
  withCompression: vi.fn((_req, res) => res),
}))

import { prisma } from '@/lib/db'
import { requireScope } from '../../_lib/authz'
import { getCachedStats, setCachedStats } from '../../_lib/stats-cache'

function makeRequest(auth = 'Bearer test-token') {
  return new NextRequest('http://localhost/api/routes-b/stats', {
    headers: { authorization: auth },
  })
}

describe('GET /api/routes-b/stats', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns cached stats when available', async () => {
    const cached = {
      invoices: { total: 5, pending: 1, paid: 3, cancelled: 0, overdue: 1 },
      totalEarned: 1000,
      pendingWithdrawals: 2,
    }
    vi.mocked(requireScope).mockResolvedValue({ userId: 'u1', role: 'user', scopes: ['routes-b:read'] })
    vi.mocked(getCachedStats).mockReturnValue(cached)

    const { GET } = await import('../route')
    const res = await GET(makeRequest())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual(cached)
    expect(res.headers.get('X-Cache')).toBe('HIT')
  })

  it('computes and caches stats on cache miss', async () => {
    vi.mocked(requireScope).mockResolvedValue({ userId: 'u1', role: 'user', scopes: ['routes-b:read'] })
    vi.mocked(getCachedStats).mockReturnValue(null)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'u1' })
    vi.mocked(prisma.invoice.groupBy).mockResolvedValue([
      { status: 'paid', _count: { id: 3 } },
      { status: 'pending', _count: { id: 1 } },
    ])
    vi.mocked(prisma.transaction.aggregate).mockResolvedValue({ _sum: { amount: 500 } })
    vi.mocked(prisma.transaction.count).mockResolvedValue(2)

    const { GET } = await import('../route')
    const res = await GET(makeRequest())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.invoices.total).toBe(4)
    expect(body.invoices.paid).toBe(3)
    expect(body.invoices.pending).toBe(1)
    expect(body.totalEarned).toBe(500)
    expect(body.pendingWithdrawals).toBe(2)
    expect(res.headers.get('X-Cache')).toBe('MISS')
    expect(setCachedStats).toHaveBeenCalledWith('u1', expect.any(Object))
  })

  it('returns 404 when user not found', async () => {
    vi.mocked(requireScope).mockResolvedValue({ userId: 'u1', role: 'user', scopes: ['routes-b:read'] })
    vi.mocked(getCachedStats).mockReturnValue(null)
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)

    const { GET } = await import('../route')
    const res = await GET(makeRequest())
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('returns 403 for missing scope', async () => {
    const { RoutesBForbiddenError } = await import('../../_lib/authz')
    vi.mocked(requireScope).mockRejectedValue(new RoutesBForbiddenError('Missing required scope'))

    const { GET } = await import('../route')
    const res = await GET(makeRequest())
    const body = await res.json()

    expect(res.status).toBe(403)
    expect(body.error.code).toBe('FORBIDDEN')
  })

  it('returns 401 for missing auth', async () => {
    vi.mocked(requireScope).mockRejectedValue(new Error('no auth'))

    const { GET } = await import('../route')
    const res = await GET(makeRequest(''))
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.error.code).toBe('UNAUTHORIZED')
  })
})
