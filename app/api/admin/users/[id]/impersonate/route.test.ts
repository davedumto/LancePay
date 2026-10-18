import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { mockPrisma, mockVerifyAuthToken } = vi.hoisted(() => ({
  mockPrisma: {
    user: {
      findUnique: vi.fn(),
    },
    impersonationSession: {
      create: vi.fn(),
    },
    userSecurityEvent: {
      create: vi.fn(),
    },
    notification: {
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
  verifyImpersonationToken,
  assertImpersonationAllowsRequest,
} from './route'

function makePostRequest(
  userId: string,
  body: unknown,
  token: string | null = 'admin-token',
): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest(
    `http://localhost/api/admin/users/${userId}/impersonate`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
  )
}

describe('POST /api/admin/users/[id]/impersonate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({
      userId: 'support-admin-1',
      email: 'support@lancepay.io',
      role: 'support_admin',
    })
    mockPrisma.user.findUnique.mockImplementation(async ({ where }) => {
      if (
        where.privyId === 'support-admin-1' ||
        where.id === 'support-admin-1'
      ) {
        return {
          id: 'support-admin-1',
          email: 'support@lancepay.io',
          role: 'support_admin',
        }
      }
      if (where.id === 'other-admin-2') {
        return {
          id: 'other-admin-2',
          email: 'peer-admin@lancepay.io',
          role: 'admin',
        }
      }
      if (where.id === 'user-freelancer-1') {
        return {
          id: 'user-freelancer-1',
          email: 'freelancer@lancepay.io',
          role: 'freelancer',
        }
      }
      return null
    })
  })

  it('requires a support ticketReference (400) and rejects impersonation of other admin accounts (403)', async () => {
    const missingTicket = await POST(
      makePostRequest('user-freelancer-1', {}),
      { params: { id: 'user-freelancer-1' } },
    )
    expect(missingTicket.status).toBe(400)
    expect((await missingTicket.json()).code).toBe('SUPPORT_TICKET_REQUIRED')

    const adminTarget = await POST(
      makePostRequest('other-admin-2', { ticketReference: 'SUP-901' }),
      { params: { id: 'other-admin-2' } },
    )
    expect(adminTarget.status).toBe(403)
    expect((await adminTarget.json()).code).toBe('CANNOT_IMPERSONATE_ADMIN')
  })

  it('rejects ttlSeconds exceeding the 15-minute (900s) maximum lifetime', async () => {
    const res = await POST(
      makePostRequest('user-freelancer-1', {
        ticketReference: 'SUP-902',
        ttlSeconds: 1800,
      }),
      { params: { id: 'user-freelancer-1' } },
    )
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('TTL_EXCEEDS_MAX_15_MINUTES')
  })

  it('issues a read-only 15-minute token that blocks money movement endpoints and emits a user-visible security event', async () => {
    mockPrisma.impersonationSession.create.mockImplementationOnce(
      async ({ data }) => data,
    )
    mockPrisma.userSecurityEvent.create.mockImplementationOnce(
      async ({ data }) => ({
        id: 'use-1',
        ...data,
      }),
    )
    mockPrisma.notification.create.mockResolvedValueOnce({ id: 'notif-1' })

    const res = await POST(
      makePostRequest('user-freelancer-1', {
        ticketReference: 'SUP-2026-512',
        reason: 'Investigating invoice PDF layout bug',
      }),
      { params: { id: 'user-freelancer-1' } },
    )
    expect(res.status).toBe(201)
    const body = await res.json()

    // 1. Token verifies, is scoped to 15 minutes max, and is read-only
    const claims = verifyImpersonationToken(body.token)
    expect(claims).not.toBeNull()
    expect(claims!.sub).toBe('user-freelancer-1')
    expect(claims!.act.sub).toBe('support-admin-1')
    expect(claims!.readOnly).toBe(true)
    expect(claims!.mode).toBe('read_only')
    expect(claims!.exp - claims!.iat).toBe(900)

    // 2. Money movement endpoints and state-mutating calls are blocked while impersonating
    const withdrawCheck = assertImpersonationAllowsRequest(
      claims!,
      'POST',
      '/api/withdrawals/initiate',
    )
    expect(withdrawCheck.allowed).toBe(false)
    if (!withdrawCheck.allowed) {
      expect(withdrawCheck.code).toBe('IMPERSONATION_MONEY_MOVEMENT_BLOCKED')
    }

    const getCheck = assertImpersonationAllowsRequest(
      claims!,
      'GET',
      '/api/invoices',
    )
    expect(getCheck.allowed).toBe(true)

    // 3. Emits a user-visible security event and notification for the account holder
    expect(mockPrisma.userSecurityEvent.create).toHaveBeenCalledOnce()
    const secEventArg =
      mockPrisma.userSecurityEvent.create.mock.calls[0][0].data
    expect(secEventArg.userId).toBe('user-freelancer-1')
    expect(secEventArg.visibleToUser).toBe(true)
    expect(secEventArg.ticketReference).toBe('SUP-2026-512')

    expect(mockPrisma.notification.create).toHaveBeenCalledOnce()
    expect(mockPrisma.notification.create.mock.calls[0][0].data.userId).toBe(
      'user-freelancer-1',
    )
  })
})
