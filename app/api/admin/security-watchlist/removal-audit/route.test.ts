import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockPrisma = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn(),
  },
  securityWatchlistRemovalAudit: {
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

describe('GET /api/admin/security-watchlist/removal-audit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'did:privy:actor_1' })
  })

  it('restricts access to admin or compliance roles and rejects ordinary users with 403', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'user_regular',
      email: 'user@example.com',
      role: 'user',
    })

    const forbiddenReq = new NextRequest(
      'http://localhost/api/admin/security-watchlist/removal-audit',
      {
        method: 'GET',
        headers: { authorization: 'Bearer valid_token' },
      },
    )
    const forbiddenRes = await GET(forbiddenReq)
    expect(forbiddenRes.status).toBe(403)
    expect(mockPrisma.securityWatchlistRemovalAudit.findMany).not.toHaveBeenCalled()

    // Compliance role succeeds
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'user_compliance',
      email: 'compliance@lancepay.io',
      role: 'compliance',
    })
    mockPrisma.securityWatchlistRemovalAudit.findMany.mockResolvedValueOnce([])

    const complianceReq = new NextRequest(
      'http://localhost/api/admin/security-watchlist/removal-audit',
      {
        method: 'GET',
        headers: { authorization: 'Bearer valid_token' },
      },
    )
    const complianceRes = await GET(complianceReq)
    expect(complianceRes.status).toBe(200)
  })

  it('supports filtering by value or by removedById', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'admin_1',
      email: 'admin@lancepay.io',
      role: 'admin',
    })
    mockPrisma.securityWatchlistRemovalAudit.findMany.mockResolvedValue([])

    const byValueReq = new NextRequest(
      'http://localhost/api/admin/security-watchlist/removal-audit?value=GABC123456',
      {
        method: 'GET',
        headers: { authorization: 'Bearer valid_token' },
      },
    )
    const byValueRes = await GET(byValueReq)
    expect(byValueRes.status).toBe(200)
    expect(
      mockPrisma.securityWatchlistRemovalAudit.findMany,
    ).toHaveBeenCalledWith({
      where: { value: 'GABC123456' },
      orderBy: { removedAt: 'desc' },
    })

    const byRemoverReq = new NextRequest(
      'http://localhost/api/admin/security-watchlist/removal-audit?removedById=admin_42',
      {
        method: 'GET',
        headers: { authorization: 'Bearer valid_token' },
      },
    )
    const byRemoverRes = await GET(byRemoverReq)
    expect(byRemoverRes.status).toBe(200)
    expect(
      mockPrisma.securityWatchlistRemovalAudit.findMany,
    ).toHaveBeenCalledWith({
      where: { removedById: 'admin_42' },
      orderBy: { removedAt: 'desc' },
    })
  })

  it('ensures additionReason and removalReason are both always present in the response', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'admin_1',
      email: 'admin@lancepay.io',
      role: 'admin',
    })
    mockPrisma.securityWatchlistRemovalAudit.findMany.mockResolvedValue([
      {
        id: 'audit_1',
        watchlistId: 'wl_1',
        type: 'wallet',
        value: 'GXYZ987654321',
        additionReason: 'Flagged by automated velocity heuristic',
        removalReason: 'Cleared after manual KYC and invoice review',
        removedById: 'admin_1',
        removedAt: new Date('2026-06-05T10:00:00.000Z'),
      },
      {
        id: 'audit_2',
        watchlistId: 'wl_2',
        type: 'email',
        value: 'contractor@example.com',
        additionReason: '',
        removalReason: 'Verified false positive',
        removedById: 'admin_1',
        removedAt: new Date('2026-06-04T09:00:00.000Z'),
      },
    ])

    const req = new NextRequest(
      'http://localhost/api/admin/security-watchlist/removal-audit',
      {
        method: 'GET',
        headers: { authorization: 'Bearer valid_token' },
      },
    )

    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.total).toBe(2)
    for (const item of body.entries) {
      expect(typeof item.additionReason).toBe('string')
      expect(item.additionReason.length).toBeGreaterThan(0)
      expect(typeof item.removalReason).toBe('string')
      expect(item.removalReason.length).toBeGreaterThan(0)
    }

    expect(body.entries[0]).toMatchObject({
      id: 'audit_1',
      value: 'GXYZ987654321',
      additionReason: 'Flagged by automated velocity heuristic',
      removalReason: 'Cleared after manual KYC and invoice review',
      removedById: 'admin_1',
    })
    expect(body.entries[1]).toMatchObject({
      id: 'audit_2',
      additionReason: 'No addition reason recorded',
      removalReason: 'Verified false positive',
    })
  })
})
