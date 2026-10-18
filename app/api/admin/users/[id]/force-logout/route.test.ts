import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { mockPrisma, mockVerifyAuthToken } = vi.hoisted(() => {
  const txMethods = {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    userSession: {
      updateMany: vi.fn(),
    },
    refreshToken: {
      updateMany: vi.fn(),
    },
    embeddedWalletSession: {
      updateMany: vi.fn(),
    },
    anchorSession: {
      deleteMany: vi.fn(),
    },
    securityAuditLog: {
      create: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  }
  return {
    mockPrisma: {
      ...txMethods,
      $transaction: vi.fn(async (cb: (tx: typeof txMethods) => unknown) =>
        cb(txMethods),
      ),
    },
    mockVerifyAuthToken: vi.fn(),
  }
})

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: mockVerifyAuthToken }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import {
  POST,
  isAccessTokenSessionVersionValid,
  resetSessionVersionCache,
} from './route'

function makePostRequest(
  userId: string,
  body: unknown,
  token: string | null = 'admin-token',
): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest(
    `http://localhost/api/admin/users/${userId}/force-logout`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
  )
}

describe('POST /api/admin/users/[id]/force-logout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSessionVersionCache()

    mockVerifyAuthToken.mockResolvedValue({
      userId: 'sec-admin-1',
      email: 'secops@lancepay.io',
      role: 'security_admin',
    })
    mockPrisma.user.findUnique.mockImplementation(async ({ where }) => {
      if (where.privyId === 'sec-admin-1' || where.id === 'sec-admin-1') {
        return {
          id: 'sec-admin-1',
          email: 'secops@lancepay.io',
          role: 'security_admin',
        }
      }
      if (where.id === 'user-target-1') {
        return {
          id: 'user-target-1',
          email: 'compromised@lancepay.io',
          role: 'freelancer',
          sessionVersion: 3,
        }
      }
      return null
    })
  })

  it('requires admin auth (401/403) and a non-empty security reason (400)', async () => {
    const unauth = await POST(
      makePostRequest('user-target-1', { reason: 'Compromised credential' }, null),
      { params: { id: 'user-target-1' } },
    )
    expect(unauth.status).toBe(401)

    const missingReason = await POST(
      makePostRequest('user-target-1', { reason: 'abc' }),
      { params: { id: 'user-target-1' } },
    )
    expect(missingReason.status).toBe(400)
    expect((await missingReason.json()).code).toBe('REASON_REQUIRED')
  })

  it('bumps sessionVersion, revokes refresh tokens and embedded wallet sessions in a single atomic transaction, and logs the forcing admin and reason', async () => {
    mockPrisma.user.update.mockResolvedValueOnce({
      id: 'user-target-1',
      sessionVersion: 4,
    })
    mockPrisma.userSession.updateMany.mockResolvedValueOnce({ count: 3 })
    mockPrisma.refreshToken.updateMany.mockResolvedValueOnce({ count: 2 })
    mockPrisma.embeddedWalletSession.updateMany.mockResolvedValueOnce({
      count: 1,
    })
    mockPrisma.anchorSession.deleteMany.mockResolvedValueOnce({ count: 1 })
    mockPrisma.securityAuditLog.create.mockResolvedValueOnce({
      id: 'sec-audit-101',
    })

    // Before force-logout, access token with sessionVersion=3 is valid
    expect(isAccessTokenSessionVersionValid('user-target-1', 3)).toBe(true)

    const res = await POST(
      makePostRequest('user-target-1', {
        reason: 'Suspicious login from unfamiliar ASN and device fingerprint',
      }),
      { params: { id: 'user-target-1' } },
    )

    expect(res.status).toBe(200)
    const body = await res.json()

    // 1. Executed inside a single atomic prisma.$transaction
    expect(mockPrisma.$transaction).toHaveBeenCalledOnce()

    // 2. Bumped sessionVersion from 3 -> 4 so prior access tokens (v3) fail validation
    expect(body.previousSessionVersion).toBe(3)
    expect(body.sessionVersion).toBe(4)
    expect(isAccessTokenSessionVersionValid('user-target-1', 3)).toBe(false)
    expect(isAccessTokenSessionVersionValid('user-target-1', 4)).toBe(true)

    // 3. Revoked all refresh tokens, user sessions, and embedded wallet sessions
    expect(mockPrisma.userSession.updateMany).toHaveBeenCalledOnce()
    expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledOnce()
    expect(mockPrisma.embeddedWalletSession.updateMany).toHaveBeenCalledOnce()
    expect(mockPrisma.anchorSession.deleteMany).toHaveBeenCalledOnce()
    expect(body.revoked).toEqual({
      userSessions: 3,
      refreshTokens: 2,
      embeddedWalletSessions: 1,
      anchorSessions: 1,
    })

    // 4. Recorded forcing admin and reason in security audit log
    expect(mockPrisma.securityAuditLog.create).toHaveBeenCalledOnce()
    const auditArg = mockPrisma.securityAuditLog.create.mock.calls[0][0].data
    expect(auditArg.actorAdminId).toBe('sec-admin-1')
    expect(auditArg.actorAdminEmail).toBe('secops@lancepay.io')
    expect(auditArg.reason).toBe(
      'Suspicious login from unfamiliar ASN and device fingerprint',
    )
    expect(auditArg.previousSessionVersion).toBe(3)
    expect(auditArg.newSessionVersion).toBe(4)
  })

  it('does not bump cached sessionVersion if the atomic transaction fails', async () => {
    mockPrisma.$transaction.mockRejectedValueOnce(
      new Error('Transaction deadlock'),
    )

    const res = await POST(
      makePostRequest('user-target-1', {
        reason: 'Emergency credential rotation',
      }),
      { params: { id: 'user-target-1' } },
    )
    expect(res.status).toBe(500)
    expect(isAccessTokenSessionVersionValid('user-target-1', 1)).toBe(true)
  })
})
