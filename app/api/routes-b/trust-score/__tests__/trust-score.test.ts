import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    invoice: { aggregate: vi.fn(), count: vi.fn() },
    dispute: { count: vi.fn() },
    userTrustScore: { upsert: vi.fn() },
  },
}))

vi.mock('../../_lib/authz', () => ({
  requireScope: vi.fn(),
  RoutesBForbiddenError: class RoutesBForbiddenError extends Error {
    code = 'FORBIDDEN'
  },
}))

vi.mock('../../_lib/cache', () => ({
  getCacheValue: vi.fn(),
  setCacheValue: vi.fn(),
}))

vi.mock('../../_lib/trust-score-history', () => ({
  recordTrustScoreSnapshot: vi.fn(),
}))

vi.mock('../../_lib/trust-score-components', () => ({
  computeTrustScore: vi.fn(() => 75),
}))

import { prisma } from '@/lib/db'
import { requireScope } from '../../_lib/authz'
import { getCacheValue, setCacheValue } from '../../_lib/cache'
import { computeTrustScore } from '../../_lib/trust-score-components'

function makeRequest(params = '') {
  const url = `http://localhost/api/routes-b/trust-score${params}`
  return new NextRequest(url, {
    headers: { authorization: 'Bearer test-token' },
  })
}

describe('GET /api/routes-b/trust-score', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns cached trust score on HIT', async () => {
    const cached = {
      trustScore: { score: 80, totalVolumeUsdc: 5000, disputeCount: 0, updatedAt: new Date() },
    }
    vi.mocked(requireScope).mockResolvedValue({ userId: 'u1', role: 'user', scopes: ['routes-b:read'] })
    vi.mocked(getCacheValue).mockReturnValue(cached)

    const { GET } = await import('../route')
    const res = await GET(makeRequest())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.trustScore.score).toBe(80)
    expect(res.headers.get('X-Cache')).toBe('HIT')
  })

  it('recomputes trust score on cache miss', async () => {
    vi.mocked(requireScope).mockResolvedValue({ userId: 'u1', role: 'user', scopes: ['routes-b:read'] })
    vi.mocked(getCacheValue).mockReturnValue(null)
    vi.mocked(prisma.invoice.aggregate).mockResolvedValue({ _sum: { amount: 1000 } })
    vi.mocked(prisma.invoice.count).mockResolvedValue(5)
    vi.mocked(prisma.dispute.count).mockResolvedValue(1)
    vi.mocked(computeTrustScore).mockReturnValue(75)
    vi.mocked(prisma.userTrustScore.upsert).mockResolvedValue({
      score: 75,
      totalVolumeUsdc: 1000,
      disputeCount: 1,
      lastUpdatedAt: new Date(),
    })

    const { GET } = await import('../route')
    const res = await GET(makeRequest())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.trustScore.score).toBe(75)
    expect(body.trustScore.totalVolumeUsdc).toBe(1000)
    expect(body.trustScore.disputeCount).toBe(1)
    expect(res.headers.get('X-Cache')).toBe('MISS')
    expect(setCacheValue).toHaveBeenCalled()
  })

  it('force recomputes for admin users', async () => {
    vi.mocked(requireScope).mockResolvedValue({ userId: 'u1', role: 'admin', scopes: ['routes-b:read'] })
    vi.mocked(prisma.invoice.aggregate).mockResolvedValue({ _sum: { amount: 2000 } })
    vi.mocked(prisma.invoice.count).mockResolvedValue(10)
    vi.mocked(prisma.dispute.count).mockResolvedValue(0)
    vi.mocked(computeTrustScore).mockReturnValue(95)
    vi.mocked(prisma.userTrustScore.upsert).mockResolvedValue({
      score: 95,
      totalVolumeUsdc: 2000,
      disputeCount: 0,
      lastUpdatedAt: new Date(),
    })

    const { GET } = await import('../route')
    const res = await GET(makeRequest('?force=true'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.trustScore.score).toBe(95)
    expect(getCacheValue).not.toHaveBeenCalled()
  })

  it('returns 403 for force=true with non-admin role', async () => {
    vi.mocked(requireScope).mockResolvedValue({ userId: 'u1', role: 'user', scopes: ['routes-b:read'] })

    const { GET } = await import('../route')
    const res = await GET(makeRequest('?force=true'))
    const body = await res.json()

    expect(res.status).toBe(403)
    expect(body.error).toBe('Forbidden')
    expect(body.code).toBe('FORBIDDEN')
  })

  it('returns 403 for missing scope', async () => {
    const { RoutesBForbiddenError } = await import('../../_lib/authz')
    vi.mocked(requireScope).mockRejectedValue(new RoutesBForbiddenError('Missing required scope'))

    const { GET } = await import('../route')
    const res = await GET(makeRequest())
    const body = await res.json()

    expect(res.status).toBe(403)
    expect(body.error).toBe('Forbidden')
    expect(body.code).toBe('FORBIDDEN')
  })

  it('returns 401 for missing auth token', async () => {
    vi.mocked(requireScope).mockRejectedValue(new Error('no auth'))

    const { GET } = await import('../route')
    const req = new NextRequest('http://localhost/api/routes-b/trust-score')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.error).toBe('Unauthorized')
  })
})
