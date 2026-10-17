import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    securityWatchlistRemovalAudit: { findMany: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const ADMIN_ID = '99999999-9999-4999-8999-999999999999'
const COMPLIANCE_ID = '88888888-8888-4888-8888-888888888888'

const mockAudit = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  watchlistId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  type: 'ip',
  value: '192.168.1.1',
  additionReason: 'Suspicious login attempts',
  removalReason: 'False positive confirmed',
  removedById: ADMIN_ID,
  removedAt: new Date('2026-07-15T10:00:00Z'),
  removedBy: { id: ADMIN_ID, email: 'admin@example.com', name: 'Admin User', role: 'admin' },
}

function makeRequest(url = 'http://localhost/api/admin/security-watchlist/removal-audit', token = 'admin-token') {
  return new NextRequest(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockImplementation(async (token) => {
    if (token === 'admin-token') return { userId: 'privy-admin' } as any
    if (token === 'compliance-token') return { userId: 'privy-compliance' } as any
    return null
  })
  vi.mocked(prisma.user.findUnique).mockImplementation(async (args: any) => {
    if (args.where.privyId === 'privy-admin') return { id: ADMIN_ID, role: 'admin', email: 'admin@example.com' } as any
    if (args.where.privyId === 'privy-compliance') return { id: COMPLIANCE_ID, role: 'compliance', email: 'compliance@example.com' } as any
    return null
  })
  vi.mocked(prisma.securityWatchlistRemovalAudit.findMany).mockResolvedValue([mockAudit] as any)
})

describe('GET /api/admin/security-watchlist/removal-audit', () => {
  it('returns all audit rows for an admin', async () => {
    const res = await GET(makeRequest())
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.audits).toHaveLength(1)
    expect(data.audits[0].additionReason).toBe('Suspicious login attempts')
    expect(data.audits[0].removalReason).toBe('False positive confirmed')
    expect(data.audits[0].removedBy).toBeDefined()
  })

  it('returns all audit rows for a compliance role', async () => {
    const res = await GET(makeRequest('http://localhost/api/admin/security-watchlist/removal-audit', 'compliance-token'))
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.audits).toHaveLength(1)
  })

  it('always includes additionReason and removalReason in each row', async () => {
    const res = await GET(makeRequest())
    const data = await res.json()

    for (const audit of data.audits) {
      expect(audit.additionReason).toBeDefined()
      expect(audit.additionReason).not.toBeNull()
      expect(audit.removalReason).toBeDefined()
      expect(audit.removalReason).not.toBeNull()
    }
  })

  it('returns an empty array when no audit rows exist', async () => {
    vi.mocked(prisma.securityWatchlistRemovalAudit.findMany).mockResolvedValue([])

    const res = await GET(makeRequest())
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.audits).toEqual([])
  })

  it('filters by value when ?value= is supplied', async () => {
    vi.mocked(prisma.securityWatchlistRemovalAudit.findMany).mockResolvedValue([mockAudit] as any)

    const res = await GET(makeRequest('http://localhost/api/admin/security-watchlist/removal-audit?value=192.168.1.1'))
    expect(res.status).toBe(200)

    expect(vi.mocked(prisma.securityWatchlistRemovalAudit.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ value: '192.168.1.1' }),
      }),
    )
  })

  it('filters by removedById when ?removedById= is supplied', async () => {
    const res = await GET(
      makeRequest(`http://localhost/api/admin/security-watchlist/removal-audit?removedById=${ADMIN_ID}`),
    )
    expect(res.status).toBe(200)

    expect(vi.mocked(prisma.securityWatchlistRemovalAudit.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ removedById: ADMIN_ID }),
      }),
    )
  })

  it('supports combining both filters', async () => {
    const res = await GET(
      makeRequest(
        `http://localhost/api/admin/security-watchlist/removal-audit?value=192.168.1.1&removedById=${ADMIN_ID}`,
      ),
    )
    expect(res.status).toBe(200)

    expect(vi.mocked(prisma.securityWatchlistRemovalAudit.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ value: '192.168.1.1', removedById: ADMIN_ID }),
      }),
    )
  })

  it('returns 401 when no authorization header is present', async () => {
    const res = await GET(
      new NextRequest('http://localhost/api/admin/security-watchlist/removal-audit', { method: 'GET' }),
    )
    expect(res.status).toBe(401)
  })

  it('returns 401 when the token is invalid', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await GET(makeRequest('http://localhost/api/admin/security-watchlist/removal-audit', 'bad-token'))
    expect(res.status).toBe(401)
  })

  it('returns 403 when user is not admin or compliance', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-user' } as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1', role: 'freelancer', email: 'user@example.com' } as any)

    const res = await GET(makeRequest('http://localhost/api/admin/security-watchlist/removal-audit', 'user-token'))
    expect(res.status).toBe(403)
  })

  it('returns 404 when the authenticated user does not exist', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
    const res = await GET(makeRequest())
    expect(res.status).toBe(404)
  })

  it('returns 500 when the database throws', async () => {
    vi.mocked(prisma.securityWatchlistRemovalAudit.findMany).mockRejectedValue(new Error('DB connection failed'))

    const res = await GET(makeRequest())
    const data = await res.json()

    expect(res.status).toBe(500)
    expect(data.error).toBe('Failed to fetch security watchlist removal audit')
  })
})
