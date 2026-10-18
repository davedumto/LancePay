import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockPrisma = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn(),
  },
  userBadgeRevocation: {
    findMany: vi.fn(),
  },
}))

const mockVerifyAuthToken = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: mockVerifyAuthToken }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { GET } from './route'

describe('GET /api/admin/badges/revocations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'did:privy:actor_1' })
  })

  it('restricts access to an admin role and rejects non-admin users with 403', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'user_regular',
      email: 'user@example.com',
      role: 'user',
    })

    const req = new NextRequest(
      'http://localhost/api/admin/badges/revocations',
      {
        method: 'GET',
        headers: { authorization: 'Bearer valid_token' },
      },
    )
    const res = await GET(req)
    expect(res.status).toBe(403)
    expect(mockPrisma.userBadgeRevocation.findMany).not.toHaveBeenCalled()
  })

  it('supports filtering by userId or badgeId', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'admin_1',
      email: 'admin@lancepay.io',
      role: 'admin',
    })
    mockPrisma.userBadgeRevocation.findMany.mockResolvedValue([])

    const byUserReq = new NextRequest(
      'http://localhost/api/admin/badges/revocations?userId=user_99',
      {
        method: 'GET',
        headers: { authorization: 'Bearer valid_token' },
      },
    )
    const byUserRes = await GET(byUserReq)
    expect(byUserRes.status).toBe(200)
    expect(mockPrisma.userBadgeRevocation.findMany).toHaveBeenCalledWith({
      where: { userId: 'user_99' },
      orderBy: { revokedAt: 'desc' },
    })

    const byBadgeReq = new NextRequest(
      'http://localhost/api/admin/badges/revocations?badgeId=badge_top_rated',
      {
        method: 'GET',
        headers: { authorization: 'Bearer valid_token' },
      },
    )
    const byBadgeRes = await GET(byBadgeReq)
    expect(byBadgeRes.status).toBe(200)
    expect(mockPrisma.userBadgeRevocation.findMany).toHaveBeenCalledWith({
      where: { badgeId: 'badge_top_rated' },
      orderBy: { revokedAt: 'desc' },
    })
  })

  it('includes trigger and reason so reviewers can distinguish automated revocations from manual admin action', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'admin_1',
      email: 'admin@lancepay.io',
      role: 'admin',
    })
    mockPrisma.userBadgeRevocation.findMany.mockResolvedValue([
      {
        id: 'rev_auto_1',
        userBadgeId: 'ub_1',
        userId: 'user_10',
        badgeId: 'badge_zero_disputes',
        stellarTxHash: 'tx_hash_1',
        issuedAt: new Date('2026-01-10T00:00:00.000Z'),
        trigger: 'dispute_lost',
        reason: 'Automated revocation: invoice dispute #402 resolved in client favor',
        revokedById: null,
        revokedAt: new Date('2026-06-05T11:00:00.000Z'),
      },
      {
        id: 'rev_manual_2',
        userBadgeId: 'ub_2',
        userId: 'user_20',
        badgeId: 'badge_verified_pro',
        stellarTxHash: 'tx_hash_2',
        issuedAt: new Date('2026-02-15T00:00:00.000Z'),
        trigger: 'admin',
        reason: 'Manual revocation following compliance credential review',
        revokedById: 'admin_1',
        revokedAt: new Date('2026-06-04T15:30:00.000Z'),
      },
    ])

    const req = new NextRequest(
      'http://localhost/api/admin/badges/revocations',
      {
        method: 'GET',
        headers: { authorization: 'Bearer valid_token' },
      },
    )

    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.total).toBe(2)
    expect(body.revocations[0]).toMatchObject({
      id: 'rev_auto_1',
      userId: 'user_10',
      badgeId: 'badge_zero_disputes',
      trigger: 'dispute_lost',
      reason:
        'Automated revocation: invoice dispute #402 resolved in client favor',
      isAutomated: true,
      revocationSource: 'automated',
      revokedById: null,
    })
    expect(body.revocations[1]).toMatchObject({
      id: 'rev_manual_2',
      userId: 'user_20',
      badgeId: 'badge_verified_pro',
      trigger: 'admin',
      reason: 'Manual revocation following compliance credential review',
      isAutomated: false,
      revocationSource: 'manual_admin',
      revokedById: 'admin_1',
    })
  })
})
