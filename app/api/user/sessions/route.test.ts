import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockPrisma = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn(),
  },
  userSession: {
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

describe('GET /api/user/sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({
      userId: 'did:privy:user_1',
      sessionId: 'sess_active_recent',
    })
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user_1' })
  })

  it('distinguishes active sessions from revoked ones and orders by lastSeenAt descending', async () => {
    mockPrisma.userSession.findMany.mockResolvedValue([
      {
        id: 'sess_active_older',
        userId: 'user_1',
        deviceLabel: 'iPhone Safari',
        userAgent: 'Mozilla/5.0 (iPhone)',
        ipAddress: '10.0.0.2',
        tokenHint: 'hint_older12',
        issuedAt: new Date('2026-06-01T08:00:00.000Z'),
        lastSeenAt: new Date('2026-06-02T10:00:00.000Z'),
        revokedAt: null,
      },
      {
        id: 'sess_revoked_mid',
        userId: 'user_1',
        deviceLabel: 'Windows Edge',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0)',
        ipAddress: '10.0.0.3',
        tokenHint: 'hint_revok12',
        issuedAt: new Date('2026-06-01T09:00:00.000Z'),
        lastSeenAt: new Date('2026-06-03T12:00:00.000Z'),
        revokedAt: new Date('2026-06-03T12:30:00.000Z'),
      },
      {
        id: 'sess_active_recent',
        userId: 'user_1',
        deviceLabel: 'MacBook Pro Chrome',
        userAgent: 'Mozilla/5.0 (Macintosh)',
        ipAddress: '10.0.0.1',
        tokenHint: 'hint_recnt12',
        issuedAt: new Date('2026-06-04T08:00:00.000Z'),
        lastSeenAt: new Date('2026-06-05T15:00:00.000Z'),
        revokedAt: null,
      },
    ])

    const req = new NextRequest('http://localhost/api/user/sessions', {
      method: 'GET',
      headers: {
        authorization: 'Bearer token_with_hint_recnt12',
      },
    })

    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(mockPrisma.userSession.findMany).toHaveBeenCalledWith({
      where: { userId: 'user_1' },
      orderBy: { lastSeenAt: 'desc' },
    })

    // Ordered by lastSeenAt descending: sess_active_recent -> sess_revoked_mid -> sess_active_older
    expect(body.sessions.map((s: any) => s.id)).toEqual([
      'sess_active_recent',
      'sess_revoked_mid',
      'sess_active_older',
    ])

    // Active vs revoked distinction
    expect(body.sessions[0]).toMatchObject({
      id: 'sess_active_recent',
      status: 'active',
      isActive: true,
      isCurrent: true,
      revokedAt: null,
    })
    expect(body.sessions[1]).toMatchObject({
      id: 'sess_revoked_mid',
      status: 'revoked',
      isActive: false,
      isCurrent: false,
      revokedAt: '2026-06-03T12:30:00.000Z',
    })
    expect(body.sessions[2]).toMatchObject({
      id: 'sess_active_older',
      status: 'active',
      isActive: true,
      isCurrent: false,
      revokedAt: null,
    })

    expect(body.activeSessions.map((s: any) => s.id)).toEqual([
      'sess_active_recent',
      'sess_active_older',
    ])
    expect(body.revokedSessions.map((s: any) => s.id)).toEqual([
      'sess_revoked_mid',
    ])
    expect(body.summary).toEqual({
      total: 3,
      activeCount: 2,
      revokedCount: 1,
    })
  })

  it('never exposes full session tokens and truncates any long tokenHint to 12 chars', async () => {
    const fullSecretJwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.super_secret_payload.signature_xyz987654321'
    mockPrisma.userSession.findMany.mockResolvedValue([
      {
        id: 'sess_1',
        userId: 'user_1',
        deviceLabel: 'Linux Firefox',
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
        ipAddress: '192.168.1.50',
        tokenHint: fullSecretJwt,
        token: fullSecretJwt,
        rawToken: fullSecretJwt,
        issuedAt: new Date('2026-06-05T10:00:00.000Z'),
        lastSeenAt: new Date('2026-06-05T11:00:00.000Z'),
        revokedAt: null,
      },
    ])

    const req = new NextRequest('http://localhost/api/user/sessions', {
      method: 'GET',
      headers: {
        authorization: 'Bearer caller_token_abc',
      },
    })

    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = await res.json()

    const session = body.sessions[0]
    expect(session.tokenHint).toBe('xyz987654321')
    expect(session.tokenHint.length).toBeLessThanOrEqual(12)
    expect(session.token).toBeUndefined()
    expect(session.rawToken).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('super_secret_payload')
  })

  it('supports filtering by status=active or status=revoked and rejects invalid status filters', async () => {
    mockPrisma.userSession.findMany.mockResolvedValue([])

    const activeReq = new NextRequest(
      'http://localhost/api/user/sessions?status=active',
      {
        method: 'GET',
        headers: { authorization: 'Bearer caller_token_abc' },
      },
    )
    const activeRes = await GET(activeReq)
    expect(activeRes.status).toBe(200)
    expect(mockPrisma.userSession.findMany).toHaveBeenCalledWith({
      where: { userId: 'user_1', revokedAt: null },
      orderBy: { lastSeenAt: 'desc' },
    })

    const invalidReq = new NextRequest(
      'http://localhost/api/user/sessions?status=invalid',
      {
        method: 'GET',
        headers: { authorization: 'Bearer caller_token_abc' },
      },
    )
    const invalidRes = await GET(invalidReq)
    expect(invalidRes.status).toBe(400)
  })
})
