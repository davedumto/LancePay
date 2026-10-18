import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { mockPrisma, mockVerifyAuthToken } = vi.hoisted(() => ({
  mockPrisma: {
    user: {
      findUnique: vi.fn(),
    },
    userSession: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
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
  authenticateActiveSession,
  clearRevokedSessionsCache,
} from './route'

function makePostRequest(
  body: unknown = {},
  token: string | null = 'jwt_header_payload_curr_hint_01',
  extraHeaders: Record<string, string> = {},
): NextRequest {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...extraHeaders,
  }
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest(
    'http://localhost/api/user/sessions/revoke-all-others',
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
  )
}

describe('POST /api/user/sessions/revoke-all-others', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearRevokedSessionsCache()

    mockVerifyAuthToken.mockResolvedValue({
      userId: 'privy-user-1',
    })
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'freelancer@lancepay.io',
    })
  })

  it('aborts with 400 CURRENT_SESSION_UNIDENTIFIED when current session cannot be reliably matched so caller is never signed out', async () => {
    mockPrisma.userSession.findMany.mockResolvedValueOnce([
      {
        id: 'sess-other-1',
        userId: 'user-1',
        tokenHint: 'other_hint_1',
        revokedAt: null,
      },
    ])

    const res = await POST(
      makePostRequest({}, 'jwt_with_unrecognized_suffix_999'),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('CURRENT_SESSION_UNIDENTIFIED')
    expect(mockPrisma.userSession.updateMany).not.toHaveBeenCalled()
  })

  it('excludes the current session, revokes all other active sessions, returns revokedCount, and takes effect immediately on the auth path', async () => {
    mockPrisma.userSession.findMany.mockResolvedValueOnce([
      {
        id: 'sess-current',
        userId: 'user-1',
        deviceLabel: 'MacBook Pro',
        tokenHint: 'curr_hint_01',
        revokedAt: null,
      },
      {
        id: 'sess-mobile',
        userId: 'user-1',
        deviceLabel: 'iPhone 16',
        tokenHint: 'mobi_hint_02',
        revokedAt: null,
      },
      {
        id: 'sess-tablet',
        userId: 'user-1',
        deviceLabel: 'iPad Air',
        tokenHint: 'tabl_hint_03',
        revokedAt: null,
      },
    ])
    mockPrisma.userSession.updateMany.mockResolvedValueOnce({ count: 2 })

    const res = await POST(
      makePostRequest({}, 'jwt_header_payload_curr_hint_01'),
    )
    expect(res.status).toBe(200)
    const body = await res.json()

    // 1. Current session is preserved; only the 2 other active sessions are revoked
    expect(body.preservedSessionId).toBe('sess-current')
    expect(body.revokedCount).toBe(2)
    expect(body.revokedSessionIds).toEqual(['sess-mobile', 'sess-tablet'])

    expect(mockPrisma.userSession.updateMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        revokedAt: null,
        id: { not: 'sess-current' },
      },
      data: {
        revokedAt: expect.any(Date),
      },
    })

    // 2. Revocation takes effect immediately on the authentication path:
    //    Revoked mobile session fails authentication with 401 SESSION_REVOKED
    const revokedAuthCheck = await authenticateActiveSession(
      makePostRequest({}, 'jwt_header_payload_mobi_hint_02'),
    )
    expect(revokedAuthCheck.status).toBe(401)
    expect(revokedAuthCheck.code).toBe('SESSION_REVOKED')

    //    Preserved current session continues to authenticate normally
    const currentAuthCheck = await authenticateActiveSession(
      makePostRequest({}, 'jwt_header_payload_curr_hint_01'),
    )
    expect(currentAuthCheck.status).toBe(200)
    expect(currentAuthCheck.user?.id).toBe('user-1')
  })
})
