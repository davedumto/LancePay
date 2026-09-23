import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    webhookDelivery: { groupBy: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUser = { id: 'user-1', role: 'freelancer', email: 'user@test.com' }
const mockAdmin = { id: 'admin-1', role: 'admin', email: 'admin@test.com' }
const mockClaims = { userId: 'privy-1' }

function makeRequest(params?: Record<string, string>): NextRequest {
  const url = new URL('http://localhost/api/webhook-deliveries/stats')
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return new NextRequest(url.toString(), { headers: { authorization: 'Bearer token' } })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
  vi.mocked(prisma.webhookDelivery.groupBy).mockResolvedValue([
    { webhookId: 'wh-healthy', status: 'delivered', _count: { _all: 9 } },
    { webhookId: 'wh-healthy', status: 'failed', _count: { _all: 1 } },
    { webhookId: 'wh-unhealthy', status: 'delivered', _count: { _all: 2 } },
    { webhookId: 'wh-unhealthy', status: 'failed', _count: { _all: 8 } },
    { webhookId: 'wh-unhealthy', status: 'pending', _count: { _all: 3 } },
  ] as any)
})

describe('GET /api/webhook-deliveries/stats', () => {
  it('computes per-webhook success rate and flags unhealthy endpoints', async () => {
    const res = await GET(makeRequest())
    const data = await res.json()

    expect(res.status).toBe(200)
    const healthy = data.stats.find((s: any) => s.webhookId === 'wh-healthy')
    const unhealthy = data.stats.find((s: any) => s.webhookId === 'wh-unhealthy')

    expect(healthy.successRate).toBeCloseTo(0.9)
    expect(healthy.flaggedForAutoPause).toBe(false)

    // 2 success / 10 terminal = 0.2, pending excluded from denominator.
    expect(unhealthy.successRate).toBeCloseTo(0.2)
    expect(unhealthy.pending).toBe(3)
    expect(unhealthy.flaggedForAutoPause).toBe(true)

    expect(data.flagged).toEqual(['wh-unhealthy'])
    // Unhealthiest sorted first.
    expect(data.stats[0].webhookId).toBe('wh-unhealthy')
  })

  it('scopes a non-admin caller to their own webhooks', async () => {
    await GET(makeRequest())
    expect(vi.mocked(prisma.webhookDelivery.groupBy)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ webhook: { userId: 'user-1' } }),
      }),
    )
  })

  it('lets an admin filter to a single userId', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockAdmin as any)
    await GET(makeRequest({ userId: 'target-user' }))
    expect(vi.mocked(prisma.webhookDelivery.groupBy)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ webhook: { userId: 'target-user' } }),
      }),
    )
  })

  it('forbids a non-admin from querying another account', async () => {
    const res = await GET(makeRequest({ userId: 'someone-else' }))
    expect(res.status).toBe(403)
  })

  it('does not flag a webhook below threshold with too few deliveries', async () => {
    vi.mocked(prisma.webhookDelivery.groupBy).mockResolvedValue([
      { webhookId: 'wh-x', status: 'delivered', _count: { _all: 0 } },
      { webhookId: 'wh-x', status: 'failed', _count: { _all: 2 } },
    ] as any)
    const res = await GET(makeRequest({ minDeliveries: '5' }))
    const data = await res.json()
    expect(data.stats[0].flaggedForAutoPause).toBe(false)
  })

  it('rejects an invalid windowHours', async () => {
    const res = await GET(makeRequest({ windowHours: '0' }))
    expect(res.status).toBe(400)
  })

  it('rejects an out-of-range threshold', async () => {
    const res = await GET(makeRequest({ threshold: '2' }))
    expect(res.status).toBe(400)
  })

  it('returns 401 when no token', async () => {
    const res = await GET(new NextRequest('http://localhost/api/webhook-deliveries/stats'))
    expect(res.status).toBe(401)
  })

  it('returns 401 when token invalid', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
  })

  it('returns 404 when user not found', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
    const res = await GET(makeRequest())
    expect(res.status).toBe(404)
  })

  it('returns 500 on unexpected error', async () => {
    vi.mocked(prisma.webhookDelivery.groupBy).mockRejectedValue(new Error('DB error'))
    const res = await GET(makeRequest())
    expect(res.status).toBe(500)
  })
})
