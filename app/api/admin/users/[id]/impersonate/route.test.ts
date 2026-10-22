import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { POST, decodeImpersonationToken } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
    withdrawalTransaction: {
      findFirst: vi.fn(),
    },
    emergencyRecoveryRequest: {
      findFirst: vi.fn(),
    },
    impersonationSession: {
      create: vi.fn(),
    },
  },
}))

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}))

describe('POST /api/admin/users/[id]/impersonate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function makeRequest(userId: string, body: unknown, token = 'admin-token') {
    return {
      req: new NextRequest(`http://localhost:3000/api/admin/users/${userId}/impersonate`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
      params: Promise.resolve({ id: userId }),
    }
  }

  function setupAdminAuth(isAdmin = true, adminId = 'admin_123') {
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_admin' } as any)
    ;(prisma.user.findUnique as any).mockImplementation(async ({ where }: any) => {
      if (where.privyId === 'privy_admin') {
        return {
          id: adminId,
          email: 'admin@lancepay.com',
          role: isAdmin ? 'admin' : 'user',
        }
      }
      if (where.id === 'target_user_456') {
        return {
          id: 'target_user_456',
          email: 'target@example.com',
          name: 'Target User',
          role: 'user',
        }
      }
      return null
    })
  }

  it('creates an impersonation session and issues a token encoding acting admin and target user', async () => {
    setupAdminAuth(true)

    vi.mocked(prisma.withdrawalTransaction.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.emergencyRecoveryRequest.findFirst).mockResolvedValue(null)

    const now = new Date()

    ;(prisma.impersonationSession.create as any).mockImplementation(async ({ data }: any) => ({
      id: data.id,
      adminId: data.adminId,
      targetUserId: data.targetUserId,
      token: data.token,
      justification: data.justification,
      expiresAt: data.expiresAt,
      createdAt: now,
    }))

    const justification = 'Triage transaction failure reported on ticket #8842'
    const { req, params } = makeRequest('target_user_456', { justification })
    const res = await POST(req, { params })
    const json = await res.json()

    expect(res.status).toBe(201)
    expect(json.session).toBeDefined()
    expect(json.session.adminId).toBe('admin_123')
    expect(json.session.targetUserId).toBe('target_user_456')
    expect(json.session.justification).toBe(justification)

    // Verify token encodes both acting admin and target user
    const decoded = decodeImpersonationToken(json.session.token)
    expect(decoded).not.toBeNull()
    expect((decoded as any).admin.id).toBe('admin_123')
    expect((decoded as any).targetUser.id).toBe('target_user_456')
    expect((decoded as any).targetUser.email).toBe('target@example.com')
    expect((decoded as any).justification).toBe(justification)

    expect(prisma.impersonationSession.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          adminId: 'admin_123',
          targetUserId: 'target_user_456',
          justification,
        }),
      }),
    )
  })

  it('rejects missing or empty justification string with 400', async () => {
    setupAdminAuth(true)

    const { req, params } = makeRequest('target_user_456', { justification: '   ' })
    const res = await POST(req, { params })
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.code).toBe('JUSTIFICATION_REQUIRED')
    expect(prisma.impersonationSession.create).not.toHaveBeenCalled()
  })

  it('rejects self-impersonation when admin targets their own id', async () => {
    setupAdminAuth(true, 'admin_123')

    const { req, params } = makeRequest('admin_123', {
      justification: 'Attempting to impersonate self',
    })
    const res = await POST(req, { params })
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.code).toBe('CANNOT_IMPERSONATE_SELF')
    expect(prisma.impersonationSession.create).not.toHaveBeenCalled()
  })

  it('returns 404 when target user is not found', async () => {
    setupAdminAuth(true)

    const { req, params } = makeRequest('non_existent_user', {
      justification: 'Valid justification string for non-existent user',
    })
    const res = await POST(req, { params })
    expect(res.status).toBe(404)
    expect(prisma.impersonationSession.create).not.toHaveBeenCalled()
  })

  it('rejects impersonating user with active elevated security context (pending withdrawal)', async () => {
    setupAdminAuth(true)

    vi.mocked(prisma.withdrawalTransaction.findFirst).mockResolvedValue({
      id: 'tx_with_99',
      status: 'pending',
      amount: '500.00',
      asset: 'USDC',
      createdAt: new Date(),
    } as any)

    const { req, params } = makeRequest('target_user_456', {
      justification: 'Customer reported issue during withdrawal',
    })
    const res = await POST(req, { params })
    const json = await res.json()

    expect(res.status).toBe(403)
    expect(json.code).toBe('ELEVATED_SECURITY_CONTEXT')
    expect(json.reason).toBe('pending_withdrawal_confirmation')
    expect(prisma.impersonationSession.create).not.toHaveBeenCalled()
  })

  it('rejects impersonating user with active emergency recovery pending', async () => {
    setupAdminAuth(true)

    vi.mocked(prisma.withdrawalTransaction.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.emergencyRecoveryRequest.findFirst).mockResolvedValue({
      id: 'rec_req_1',
      status: 'pending',
    } as any)

    const { req, params } = makeRequest('target_user_456', {
      justification: 'Emergency recovery support investigation',
    })
    const res = await POST(req, { params })
    const json = await res.json()

    expect(res.status).toBe(403)
    expect(json.code).toBe('ELEVATED_SECURITY_CONTEXT')
    expect(json.reason).toBe('pending_emergency_recovery')
    expect(prisma.impersonationSession.create).not.toHaveBeenCalled()
  })

  it('rejects non-admin actor with 403 Forbidden', async () => {
    setupAdminAuth(false)

    const { req, params } = makeRequest('target_user_456', {
      justification: 'Unauthorized attempt',
    })
    const res = await POST(req, { params })
    expect(res.status).toBe(403)
    expect(prisma.impersonationSession.create).not.toHaveBeenCalled()
  })

  it('rejects unauthenticated request with 403 Forbidden', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)

    const { req, params } = makeRequest('target_user_456', { justification: 'Test' }, '')
    const res = await POST(req, { params })
    expect(res.status).toBe(403)
  })

  it('rejects malformed JSON body with 400', async () => {
    setupAdminAuth(true)

    const { req, params } = makeRequest('target_user_456', 'invalid-json')
    const res = await POST(req, { params })
    expect(res.status).toBe(400)
  })

  it('returns 500 when database throws', async () => {
    setupAdminAuth(true)
    vi.mocked(prisma.withdrawalTransaction.findFirst).mockRejectedValue(
      new Error('DB failure'),
    )

    const { req, params } = makeRequest('target_user_456', {
      justification: 'Valid justification string',
    })
    const res = await POST(req, { params })
    expect(res.status).toBe(500)
  })
})
