import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { mockPrisma, mockVerifyAuthToken } = vi.hoisted(() => ({
  mockPrisma: {
    user: {
      findUnique: vi.fn(),
    },
    impersonationSession: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    tokenRevocationList: {
      create: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
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
  impersonationRevocationList,
  isImpersonationTokenRevoked,
} from './route'

function makePostRequest(
  userId: string,
  body: unknown = {},
  token: string | null = 'admin-token',
): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest(
    `http://localhost/api/admin/users/${userId}/impersonate/revoke`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
  )
}

describe('POST /api/admin/users/[id]/impersonate/revoke', () => {
  const futureExpiry = new Date(Date.now() + 600_000)

  beforeEach(() => {
    vi.clearAllMocks()
    impersonationRevocationList.clear()

    mockPrisma.impersonationSession.findUnique.mockResolvedValue({
      id: 'imp-sess-1',
      targetUserId: 'user-77',
      impersonatorAdminId: 'support-admin-1',
      tokenJti: 'jti_imp_abc123',
      status: 'active',
      revokedAt: null,
      expiresAt: futureExpiry,
    })
  })

  it('rejects a peer admin who is neither the impersonating admin nor a security lead with 403', async () => {
    mockVerifyAuthToken.mockResolvedValueOnce({
      userId: 'other-support-admin',
      email: 'other@lancepay.io',
      role: 'support_admin',
    })
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'other-support-admin',
      email: 'other@lancepay.io',
      role: 'support_admin',
    })

    const res = await POST(
      makePostRequest('user-77', { sessionId: 'imp-sess-1' }),
      { params: { id: 'user-77' } },
    )
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe(
      'FORBIDDEN_NOT_IMPERSONATOR_OR_SECURITY_LEAD',
    )
    expect(mockPrisma.impersonationSession.update).not.toHaveBeenCalled()
    expect(isImpersonationTokenRevoked('jti_imp_abc123')).toBe(false)
  })

  it('allows the impersonating admin to revoke their session, adds token jti to the edge revocation list, and updates the ledger row', async () => {
    mockVerifyAuthToken.mockResolvedValueOnce({
      userId: 'support-admin-1',
      email: 'support1@lancepay.io',
      role: 'support_admin',
    })
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'support-admin-1',
      email: 'support1@lancepay.io',
      role: 'support_admin',
    })
    mockPrisma.impersonationSession.update.mockImplementationOnce(
      async ({ data }) => ({
        id: 'imp-sess-1',
        ...data,
      }),
    )

    expect(isImpersonationTokenRevoked('jti_imp_abc123')).toBe(false)

    const res = await POST(
      makePostRequest('user-77', {
        sessionId: 'imp-sess-1',
        reason: 'Finished investigating ticket SUP-440',
      }),
      { params: { id: 'user-77' } },
    )

    expect(res.status).toBe(200)
    const body = await res.json()

    // 1. Token jti added to edge revocation list
    expect(isImpersonationTokenRevoked('jti_imp_abc123')).toBe(true)
    expect(body.revocationEntry.jti).toBe('jti_imp_abc123')

    // 2. Original impersonation ledger row updated with timestamp and actor
    expect(mockPrisma.impersonationSession.update).toHaveBeenCalledOnce()
    const updateArg = mockPrisma.impersonationSession.update.mock.calls[0][0]
    expect(updateArg.where).toEqual({ id: 'imp-sess-1' })
    expect(updateArg.data.status).toBe('revoked')
    expect(updateArg.data.revokedByAdminId).toBe('support-admin-1')
    expect(updateArg.data.revokedAt).toBeInstanceOf(Date)
  })

  it('allows a security_lead to revoke another admin active impersonation session before expiry', async () => {
    mockVerifyAuthToken.mockResolvedValueOnce({
      userId: 'sec-lead-9',
      email: 'seclead@lancepay.io',
      role: 'security_lead',
    })
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'sec-lead-9',
      email: 'seclead@lancepay.io',
      role: 'security_lead',
    })
    mockPrisma.impersonationSession.update.mockImplementationOnce(
      async ({ data }) => ({
        id: 'imp-sess-1',
        ...data,
      }),
    )

    const res = await POST(
      makePostRequest('user-77', {
        sessionId: 'imp-sess-1',
        reason: 'Security lead terminated long-running support session',
      }),
      { params: { id: 'user-77' } },
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.session.revokedByAdminId).toBe('sec-lead-9')
    expect(body.session.revokedByRole).toBe('security_lead')
    expect(isImpersonationTokenRevoked('jti_imp_abc123')).toBe(true)
  })
})
