import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from './route'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    userBadge: { findMany: vi.fn() },
    userBadgeRevocation: { findMany: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

function makeRequest(userId = 'user-1', token?: string) {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest(`http://localhost/api/users/${userId}/badges`, {
    method: 'GET',
    headers,
  })
}

const context = (id = 'user-1') => ({ params: Promise.resolve({ id }) })

const sampleUserBadges = [
  {
    id: 'ub-1',
    userId: 'user-1',
    badgeId: 'badge-1',
    stellarTxHash: 'tx-hash-1',
    issuedAt: new Date('2026-09-20T10:00:00Z'),
    badge: {
      id: 'badge-1',
      name: 'Top Earner',
      description: 'Earned $10,000+ in completed invoices',
      imageUrl: 'https://cdn.lancepay.com/badges/top-earner.svg',
      stellarAssetCode: 'LPTOP',
      criteriaJson: { type: 'revenue', minRevenue: 10000 },
      isActive: true,
    },
  },
  {
    id: 'ub-2',
    userId: 'user-1',
    badgeId: 'badge-2',
    stellarTxHash: null,
    issuedAt: new Date('2026-09-15T10:00:00Z'),
    badge: {
      id: 'badge-2',
      name: 'Zero Disputes',
      description: '25+ paid invoices with 0 disputes',
      imageUrl: 'https://cdn.lancepay.com/badges/zero-disputes.svg',
      stellarAssetCode: 'LPZERO',
      criteriaJson: { type: 'zero_disputes', minInvoices: 25, maxDisputes: 0 },
      isActive: true,
    },
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    id: 'user-1',
    publicVisibility: true,
  } as any)
  vi.mocked(prisma.userBadge.findMany).mockResolvedValue(sampleUserBadges as any)
  vi.mocked(prisma.userBadgeRevocation.findMany).mockResolvedValue([] as any)
})

describe('GET /api/users/[id]/badges', () => {
  it('returns earned badges joined with BadgeDefinition metadata for a publicly visible user', async () => {
    const res = await GET(makeRequest('user-1'), context('user-1'))
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.userId).toBe('user-1')
    expect(data.count).toBe(2)
    expect(data.badges).toHaveLength(2)
    expect(data.badges[0]).toMatchObject({
      id: 'ub-1',
      badgeId: 'badge-1',
      name: 'Top Earner',
      stellarAssetCode: 'LPTOP',
      stellarTxHash: 'tx-hash-1',
    })
  })

  it('excludes badges that have been revoked via UserBadgeRevocation', async () => {
    vi.mocked(prisma.userBadgeRevocation.findMany).mockResolvedValue([
      {
        userBadgeId: 'ub-2',
        badgeId: 'badge-2',
        revokedAt: new Date('2026-09-18T12:00:00Z'),
      },
    ] as any)

    const res = await GET(makeRequest('user-1'), context('user-1'))
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.count).toBe(1)
    expect(data.badges.map((b: { id: string }) => b.id)).toEqual(['ub-1'])
  })

  it('returns 403 for anonymous or other non-admin callers when the user opted out of publicVisibility', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: 'user-1',
      publicVisibility: false,
    } as any)

    const anonRes = await GET(makeRequest('user-1'), context('user-1'))
    expect(anonRes.status).toBe(403)
    expect(prisma.userBadge.findMany).not.toHaveBeenCalled()

    // Non-owner authenticated caller
    vi.mocked(prisma.user.findUnique)
      .mockResolvedValueOnce({ id: 'user-1', publicVisibility: false } as any)
      .mockResolvedValueOnce({ id: 'other-user', role: 'freelancer' } as any)
    vi.mocked(verifyAuthToken).mockResolvedValueOnce({ userId: 'privy-other' } as any)

    const otherRes = await GET(makeRequest('user-1', 'other-token'), context('user-1'))
    expect(otherRes.status).toBe(403)
  })

  it('allows the user themselves or an admin to view badges even when publicVisibility is false', async () => {
    // Owner viewing own badges
    vi.mocked(prisma.user.findUnique)
      .mockResolvedValueOnce({ id: 'user-1', publicVisibility: false } as any)
      .mockResolvedValueOnce({ id: 'user-1', role: 'freelancer' } as any)
    vi.mocked(verifyAuthToken).mockResolvedValueOnce({ userId: 'privy-1' } as any)

    const selfRes = await GET(makeRequest('user-1', 'self-token'), context('user-1'))
    expect(selfRes.status).toBe(200)

    // Admin viewing opted-out user's badges
    vi.mocked(prisma.user.findUnique)
      .mockResolvedValueOnce({ id: 'user-1', publicVisibility: false } as any)
      .mockResolvedValueOnce({ id: 'admin-1', role: 'admin' } as any)
    vi.mocked(verifyAuthToken).mockResolvedValueOnce({ userId: 'privy-admin' } as any)

    const adminRes = await GET(makeRequest('user-1', 'admin-token'), context('user-1'))
    expect(adminRes.status).toBe(200)
  })

  it('returns 404 when the target user does not exist', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(null)
    const res = await GET(makeRequest('missing-user'), context('missing-user'))
    expect(res.status).toBe(404)
  })

  it('returns 500 on unexpected database failure', async () => {
    vi.mocked(prisma.userBadge.findMany).mockRejectedValueOnce(new Error('DB error'))
    const res = await GET(makeRequest('user-1'), context('user-1'))
    expect(res.status).toBe(500)
  })
})
