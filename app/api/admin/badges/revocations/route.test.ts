import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    userBadgeRevocation: { findMany: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const ADMIN_ID = '99999999-9999-4999-8999-999999999999'
const USER_ID = '11111111-1111-4111-8111-111111111111'
const BADGE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SYSTEM_SECRET = 'system-secret-value'

const mockRevocation = {
  id: 'rev-00000000-0000-4000-8000-000000000001',
  userBadgeId: 'ub-00000000-0000-4000-8000-000000000001',
  userId: USER_ID,
  badgeId: BADGE_ID,
  stellarTxHash: null,
  issuedAt: new Date('2026-01-01T00:00:00Z'),
  trigger: 'admin',
  reason: 'Policy violation',
  revokedById: ADMIN_ID,
  revokedAt: new Date('2026-07-01T00:00:00Z'),
  user: { id: USER_ID, email: 'user@example.com', name: 'Test User' },
  badge: { id: BADGE_ID, name: 'VERIPRO', stellarAssetCode: 'VERIPRO' },
  revokedBy: { id: ADMIN_ID, email: 'admin@example.com', name: 'Admin User' },
}

const mockSystemRevocation = {
  ...mockRevocation,
  id: 'rev-00000000-0000-4000-8000-000000000002',
  trigger: 'dispute_lost',
  reason: 'Dispute DSP-42 resolved against user',
  revokedById: null,
  revokedBy: null,
}

function makeRequest(url = 'http://localhost/api/admin/badges/revocations', token = 'admin-token') {
  return new NextRequest(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.BADGE_SYSTEM_SECRET = SYSTEM_SECRET
  vi.mocked(verifyAuthToken).mockImplementation(async (token) => {
    if (token === 'admin-token') return { userId: 'privy-admin' } as any
    if (token === 'user-token') return { userId: 'privy-user' } as any
    return null
  })
  vi.mocked(prisma.user.findUnique).mockImplementation(async (args: any) => {
    if (args.where.privyId === 'privy-admin') return { id: ADMIN_ID, role: 'admin' } as any
    if (args.where.privyId === 'privy-user') return { id: USER_ID, role: 'freelancer' } as any
    return null
  })
  vi.mocked(prisma.userBadgeRevocation.findMany).mockResolvedValue([mockRevocation] as any)
})

describe('GET /api/admin/badges/revocations', () => {
  it('returns all revocations for an admin', async () => {
    const res = await GET(makeRequest())
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.revocations).toHaveLength(1)
    expect(data.revocations[0].trigger).toBe('admin')
    expect(data.revocations[0].reason).toBe('Policy violation')
    expect(data.revocations[0].user).toBeDefined()
    expect(data.revocations[0].badge).toBeDefined()
  })

  it('includes trigger and reason in each row to distinguish automated vs manual', async () => {
    vi.mocked(prisma.userBadgeRevocation.findMany).mockResolvedValue([
      mockRevocation,
      mockSystemRevocation,
    ] as any)

    const res = await GET(makeRequest())
    const data = await res.json()

    expect(res.status).toBe(200)
    const triggers = data.revocations.map((r: any) => r.trigger)
    expect(triggers).toContain('admin')
    expect(triggers).toContain('dispute_lost')
  })

  it('returns an empty array when no revocations exist', async () => {
    vi.mocked(prisma.userBadgeRevocation.findMany).mockResolvedValue([])

    const res = await GET(makeRequest())
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.revocations).toEqual([])
  })

  it('filters by userId when ?userId= is supplied', async () => {
    const res = await GET(
      makeRequest(`http://localhost/api/admin/badges/revocations?userId=${USER_ID}`),
    )
    expect(res.status).toBe(200)

    expect(vi.mocked(prisma.userBadgeRevocation.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: USER_ID }),
      }),
    )
  })

  it('filters by badgeId when ?badgeId= is supplied', async () => {
    const res = await GET(
      makeRequest(`http://localhost/api/admin/badges/revocations?badgeId=${BADGE_ID}`),
    )
    expect(res.status).toBe(200)

    expect(vi.mocked(prisma.userBadgeRevocation.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ badgeId: BADGE_ID }),
      }),
    )
  })

  it('supports combining userId and badgeId filters', async () => {
    const res = await GET(
      makeRequest(
        `http://localhost/api/admin/badges/revocations?userId=${USER_ID}&badgeId=${BADGE_ID}`,
      ),
    )
    expect(res.status).toBe(200)

    expect(vi.mocked(prisma.userBadgeRevocation.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: USER_ID, badgeId: BADGE_ID }),
      }),
    )
  })

  it('returns 401 when no authorization header is present', async () => {
    const res = await GET(
      new NextRequest('http://localhost/api/admin/badges/revocations', { method: 'GET' }),
    )
    expect(res.status).toBe(401)
  })

  it('returns 401 when the token is invalid and not a system secret', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await GET(makeRequest('http://localhost/api/admin/badges/revocations', 'bad-token'))
    expect(res.status).toBe(401)
  })

  it('returns 401 when BADGE_SYSTEM_SECRET is unset and a secret-like token is used', async () => {
    delete process.env.BADGE_SYSTEM_SECRET
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await GET(makeRequest('http://localhost/api/admin/badges/revocations', SYSTEM_SECRET))
    expect(res.status).toBe(401)
  })

  it('returns 403 when the authenticated user is not an admin', async () => {
    const res = await GET(makeRequest('http://localhost/api/admin/badges/revocations', 'user-token'))
    expect(res.status).toBe(403)
  })

  it('returns 403 when a system secret is used (system is not an admin user)', async () => {
    const res = await GET(makeRequest('http://localhost/api/admin/badges/revocations', SYSTEM_SECRET))
    expect(res.status).toBe(403)
  })

  it('returns 404 when the authenticated user does not exist', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
    const res = await GET(makeRequest())
    expect(res.status).toBe(404)
  })

  it('returns 500 when the database throws', async () => {
    vi.mocked(prisma.userBadgeRevocation.findMany).mockRejectedValue(new Error('DB connection failed'))

    const res = await GET(makeRequest())
    const data = await res.json()

    expect(res.status).toBe(500)
    expect(data.error).toBe('Failed to fetch badge revocations')
  })
})
