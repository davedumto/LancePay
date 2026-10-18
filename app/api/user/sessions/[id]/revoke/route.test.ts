import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { mockPrisma, mockVerifyAuthToken } = vi.hoisted(() => ({
  mockPrisma: {
    user: {
      findUnique: vi.fn(),
    },
    userSession: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
  mockVerifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: mockVerifyAuthToken }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import {
  POST,
  authenticateSessionOnAuthPath,
  clearRevokedSessionAuthCache,
} from './route'

function makePostRequest(
  sessionId: string,
  token: string | null = 'jwt_owner_token_hint_aaaa',
  extraHeaders: Record<string, string> = {},
): NextRequest {
  const headers: Record<string, string> = { ...extraHeaders }
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest(
    `http://localhost/api/user/sessions/${sessionId}/revoke`,
    {
      method: 'POST',
      headers,
    },
  )
}

describe('POST /api/user/sessions/[id]/revoke', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearRevokedSessionAuthCache()

    mockVerifyAuthToken.mockResolvedValue({
      userId: 'privy-owner-1',
    })
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-owner-1',
      email: 'owner@lancepay.io',
    })
  })

  it('rejects revoking another user session with 403 FORBIDDEN_NOT_SESSION_OWNER', async () => {
    mockPrisma.userSession.findUnique.mockResolvedValueOnce({
      id: 'sess-foreign-1',
      userId: 'other-user-99',
      tokenHint: 'foreign_hint',
      revokedAt: null,
    })

    const res = await POST(makePostRequest('sess-foreign-1'), {
      params: { id: 'sess-foreign-1' },
    })
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('FORBIDDEN_NOT_SESSION_OWNER')
    expect(mockPrisma.userSession.update).not.toHaveBeenCalled()
  })

  it('rejects revoking an already-revoked session with 409 SESSION_ALREADY_REVOKED and clear inactive state', async () => {
    mockPrisma.userSession.findUnique.mockResolvedValueOnce({
      id: 'sess-already-revoked',
      userId: 'user-owner-1',
      tokenHint: 'old_hint_111',
      revokedAt: new Date('2026-04-10T12:00:00Z'),
    })

    const res = await POST(makePostRequest('sess-already-revoked'), {
      params: { id: 'sess-already-revoked' },
    })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('SESSION_ALREADY_REVOKED')
    expect(body.status).toBe('inactive')
    expect(body.session.isActive).toBe(false)
    expect(mockPrisma.userSession.update).not.toHaveBeenCalled()
  })

  it('revokes an active owned session and enforces revocation on the authentication path', async () => {
    mockPrisma.userSession.findUnique.mockResolvedValueOnce({
      id: 'sess-target-2',
      userId: 'user-owner-1',
      deviceLabel: 'Chrome on Windows',
      tokenHint: 'revoked_hnt2',
      revokedAt: null,
    })
    mockPrisma.userSession.update.mockImplementationOnce(async ({ data }) => ({
      id: 'sess-target-2',
      userId: 'user-owner-1',
      deviceLabel: 'Chrome on Windows',
      tokenHint: 'revoked_hnt2',
      revokedAt: data.revokedAt,
    }))

    const res = await POST(makePostRequest('sess-target-2'), {
      params: { id: 'sess-target-2' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.revoked).toBe(true)
    expect(body.session.status).toBe('revoked')
    expect(body.session.isActive).toBe(false)

    // Subsequent request using the revoked session token is rejected on the auth path with 401 SESSION_REVOKED
    const authAttemptWithRevokedToken = await authenticateSessionOnAuthPath(
      makePostRequest('sess-target-2', 'jwt_payload_revoked_hnt2'),
    )
    expect(authAttemptWithRevokedToken.status).toBe(401)
    expect(authAttemptWithRevokedToken.code).toBe('SESSION_REVOKED')
  })
})
