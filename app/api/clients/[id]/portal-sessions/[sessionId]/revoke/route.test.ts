import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockPrisma = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn(),
  },
  clientPortalSession: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
}))

const mockVerifyAuthToken = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: mockVerifyAuthToken }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
  POST,
  seedClientPortalSessionCache,
  isClientPortalSessionActive,
  resetClientPortalSessionRuntimeState,
} from './route'

describe('POST /api/clients/[id]/portal-sessions/[sessionId]/revoke', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetClientPortalSessionRuntimeState()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'did:privy:owner_1' })
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user_owner_1' })
  })

  it('sets revokedAt and ensures any in-flight request using that session is rejected immediately without a stale cache window', async () => {
    seedClientPortalSessionCache({
      sessionId: 'psess_1',
      hashedToken: 'sha256_portal_token_1',
      expiresAt: new Date(Date.now() + 3600_000),
    })
    expect(
      isClientPortalSessionActive({
        sessionId: 'psess_1',
        hashedToken: 'sha256_portal_token_1',
      }),
    ).toBe(true)

    mockPrisma.clientPortalSession.findUnique.mockResolvedValue({
      id: 'psess_1',
      userId: 'user_owner_1',
      clientId: 'client_100',
      hashedToken: 'sha256_portal_token_1',
      tokenHint: 'cps_12345678',
      lastSeenAt: new Date('2026-06-05T09:00:00.000Z'),
      revokedAt: null,
      expiresAt: new Date(Date.now() + 3600_000),
      createdAt: new Date('2026-06-05T08:00:00.000Z'),
    })

    mockPrisma.clientPortalSession.update.mockImplementation(
      async ({ data }: { data: { revokedAt: Date } }) => ({
        id: 'psess_1',
        userId: 'user_owner_1',
        clientId: 'client_100',
        hashedToken: 'sha256_portal_token_1',
        tokenHint: 'cps_12345678',
        lastSeenAt: new Date('2026-06-05T09:00:00.000Z'),
        revokedAt: data.revokedAt,
        expiresAt: new Date(Date.now() + 3600_000),
        createdAt: new Date('2026-06-05T08:00:00.000Z'),
      }),
    )

    const req = new NextRequest(
      'http://localhost/api/clients/client_100/portal-sessions/psess_1/revoke',
      {
        method: 'POST',
        headers: { authorization: 'Bearer valid_token' },
      },
    )

    const res = await POST(req, {
      params: { id: 'client_100', sessionId: 'psess_1' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.revoked).toBe(true)
    expect(body.session.revokedAt).toBeTruthy()

    // In-flight checks by sessionId or hashedToken are rejected immediately (no stale cache window)
    expect(isClientPortalSessionActive({ sessionId: 'psess_1' })).toBe(false)
    expect(
      isClientPortalSessionActive({ hashedToken: 'sha256_portal_token_1' }),
    ).toBe(false)
  })

  it('rejects revoking a session that is already revoked or expired with a clear already-inactive state', async () => {
    // 1. Already revoked
    mockPrisma.clientPortalSession.findUnique.mockResolvedValueOnce({
      id: 'psess_revoked',
      userId: 'user_owner_1',
      clientId: 'client_100',
      hashedToken: 'sha256_portal_token_rev',
      tokenHint: 'cps_revoked1',
      revokedAt: new Date('2026-06-04T12:00:00.000Z'),
      expiresAt: new Date(Date.now() + 3600_000),
    })

    const revokedReq = new NextRequest(
      'http://localhost/api/clients/client_100/portal-sessions/psess_revoked/revoke',
      {
        method: 'POST',
        headers: { authorization: 'Bearer valid_token' },
      },
    )
    const revokedRes = await POST(revokedReq, {
      params: { id: 'client_100', sessionId: 'psess_revoked' },
    })
    expect(revokedRes.status).toBe(409)
    const revokedBody = await revokedRes.json()
    expect(revokedBody).toMatchObject({
      code: 'PORTAL_SESSION_ALREADY_INACTIVE',
      alreadyInactive: true,
      inactiveReason: 'already_revoked',
    })

    // 2. Already expired
    mockPrisma.clientPortalSession.findUnique.mockResolvedValueOnce({
      id: 'psess_expired',
      userId: 'user_owner_1',
      clientId: 'client_100',
      hashedToken: 'sha256_portal_token_exp',
      tokenHint: 'cps_expired1',
      revokedAt: null,
      expiresAt: new Date(Date.now() - 60_000),
    })

    const expiredReq = new NextRequest(
      'http://localhost/api/clients/client_100/portal-sessions/psess_expired/revoke',
      {
        method: 'POST',
        headers: { authorization: 'Bearer valid_token' },
      },
    )
    const expiredRes = await POST(expiredReq, {
      params: { id: 'client_100', sessionId: 'psess_expired' },
    })
    expect(expiredRes.status).toBe(409)
    const expiredBody = await expiredRes.json()
    expect(expiredBody).toMatchObject({
      code: 'PORTAL_SESSION_ALREADY_INACTIVE',
      alreadyInactive: true,
      inactiveReason: 'already_expired',
    })
    expect(mockPrisma.clientPortalSession.update).not.toHaveBeenCalled()
  })

  it('permits only the session owner to revoke their own client portal session', async () => {
    mockPrisma.clientPortalSession.findUnique.mockResolvedValueOnce({
      id: 'psess_other_owner',
      userId: 'other_freelancer_99',
      clientId: 'client_100',
      hashedToken: 'sha256_other',
      tokenHint: 'cps_other999',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 3600_000),
    })

    const req = new NextRequest(
      'http://localhost/api/clients/client_100/portal-sessions/psess_other_owner/revoke',
      {
        method: 'POST',
        headers: { authorization: 'Bearer valid_token' },
      },
    )
    const res = await POST(req, {
      params: { id: 'client_100', sessionId: 'psess_other_owner' },
    })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('FORBIDDEN_NOT_SESSION_OWNER')
    expect(mockPrisma.clientPortalSession.update).not.toHaveBeenCalled()
  })
})
