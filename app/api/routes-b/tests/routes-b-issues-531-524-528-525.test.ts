import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { clearCache } from '../_lib/cache'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
    invoice: { groupBy: vi.fn(), aggregate: vi.fn(), count: vi.fn() },
    transaction: { aggregate: vi.fn(), count: vi.fn() },
    dispute: { count: vi.fn() },
    userTrustScore: { upsert: vi.fn() },
  },
}))
vi.mock('../_lib/authz', () => ({
  requireScope: vi.fn(),
  RoutesBForbiddenError: class RoutesBForbiddenError extends Error {
    code = 'FORBIDDEN'
  },
}))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { requireScope } from '../_lib/authz'

describe('routes-b issues 531/524/528/525', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearCache()
  })

  it('531: invoices summary returns all known statuses with zeros', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' } as never)
    vi.mocked(prisma.invoice.groupBy).mockResolvedValue([
      { status: 'paid', _count: { id: 2 }, _sum: { amount: 45 } },
      { status: 'pending', _count: { id: 1 }, _sum: { amount: 10 } },
    ] as never)

    const { GET } = await import('../invoices/summary/route')
    const req = new NextRequest('http://localhost/api/routes-b/invoices/summary', {
      headers: { authorization: 'Bearer t' },
    })
    const res = await GET(req)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(prisma.invoice.groupBy).toHaveBeenCalledTimes(1)
    expect(json.summary).toEqual([
      { status: 'pending', count: 1, total: 10 },
      { status: 'paid', count: 2, total: 45 },
      { status: 'cancelled', count: 0, total: 0 },
      { status: 'overdue', count: 0, total: 0 },
    ])
  })

  it('528: stats cache hit avoids duplicate aggregates and isolates by user', async () => {
    vi.mocked(requireScope)
      .mockResolvedValueOnce({ userId: 'user-1', role: 'freelancer', scopes: ['routes-b:read'] } as never)
      .mockResolvedValueOnce({ userId: 'user-1', role: 'freelancer', scopes: ['routes-b:read'] } as never)
      .mockResolvedValueOnce({ userId: 'user-2', role: 'freelancer', scopes: ['routes-b:read'] } as never)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' } as never)
    vi.mocked(prisma.invoice.groupBy).mockResolvedValue([{ status: 'paid', _count: { id: 1 } }] as never)
    vi.mocked(prisma.transaction.aggregate).mockResolvedValue({ _sum: { amount: 200 } } as never)
    vi.mocked(prisma.transaction.count).mockResolvedValue(0 as never)

    const { GET } = await import('../stats/route')
    const req = new NextRequest('http://localhost/api/routes-b/stats')
    const first = await GET(req)
    const second = await GET(req)
    const third = await GET(req)

    expect(first.headers.get('X-Cache')).toBe('MISS')
    expect(second.headers.get('X-Cache')).toBe('HIT')
    expect(third.headers.get('X-Cache')).toBe('MISS')
    expect(prisma.invoice.groupBy).toHaveBeenCalledTimes(2)
  })

  it('524: trust-score throttles recomputes and force=true is admin-only', async () => {
    vi.mocked(requireScope)
      .mockResolvedValueOnce({ userId: 'user-1', role: 'freelancer', scopes: ['routes-b:read'] } as never)
      .mockResolvedValueOnce({ userId: 'user-1', role: 'freelancer', scopes: ['routes-b:read'] } as never)
      .mockResolvedValueOnce({ userId: 'user-1', role: 'freelancer', scopes: ['routes-b:read'] } as never)
      .mockResolvedValueOnce({ userId: 'user-1', role: 'admin', scopes: ['routes-b:read'] } as never)
    vi.mocked(prisma.invoice.aggregate).mockResolvedValue({ _sum: { amount: 5000 } } as never)
    vi.mocked(prisma.invoice.count).mockResolvedValue(5 as never)
    vi.mocked(prisma.dispute.count).mockResolvedValue(1 as never)
    vi.mocked(prisma.userTrustScore.upsert).mockResolvedValue({
      score: 65,
      totalVolumeUsdc: 5000,
      disputeCount: 1,
      lastUpdatedAt: new Date('2026-01-01T00:00:00.000Z'),
    } as never)

    const { GET } = await import('../trust-score/route')
    const baseReq = new NextRequest('http://localhost/api/routes-b/trust-score')
    const forceReqUser = new NextRequest('http://localhost/api/routes-b/trust-score?force=true')
    const forceReqAdmin = new NextRequest('http://localhost/api/routes-b/trust-score?force=true')

    const first = await GET(baseReq)
    const second = await GET(baseReq)
    const deniedForce = await GET(forceReqUser)
    const forced = await GET(forceReqAdmin)

    expect(first.headers.get('X-Cache')).toBe('MISS')
    expect(second.headers.get('X-Cache')).toBe('HIT')
    expect(deniedForce.status).toBe(403)
    expect(forced.headers.get('X-Cache')).toBe('MISS')
    expect(prisma.userTrustScore.upsert).toHaveBeenCalledTimes(2)
  })

  it('525: avatar finalize rejects oversize and spoofed MIME, accepts valid PNG', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' } as never)
    vi.mocked(prisma.user.update).mockResolvedValue({ avatarUrl: 'https://example.com/a.jpg' } as never)

    const { POST } = await import('../profile/avatar/finalize/route')

    const oversized = Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64')
    const tooBigReq = new NextRequest('http://localhost/api/routes-b/profile/avatar/finalize', {
      method: 'POST',
      headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'avatars/user-1/1', fileBase64: oversized }),
    })
    const tooBigRes = await POST(tooBigReq)
    expect(tooBigRes.status).toBe(413)
    expect(prisma.user.update).not.toHaveBeenCalled()

    const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02])
    const spoofReq = new NextRequest('http://localhost/api/routes-b/profile/avatar/finalize', {
      method: 'POST',
      headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'avatars/user-1/1', fileBase64: Buffer.from(pngBytes).toString('base64'), contentType: 'image/jpeg' }),
    })
    const spoofRes = await POST(spoofReq)
    expect(spoofRes.status).toBe(415)

    const okReq = new NextRequest('http://localhost/api/routes-b/profile/avatar/finalize', {
      method: 'POST',
      headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'avatars/user-1/2', fileBase64: Buffer.from(pngBytes).toString('base64'), contentType: 'image/png' }),
    })
    const okRes = await POST(okReq)
    expect(okRes.status).toBe(200)
    expect(prisma.user.update).toHaveBeenCalledTimes(1)
  })
})
