import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
    featureFlag: {
      findFirst: vi.fn(),
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

describe('POST /api/admin/feature-flags', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function makeRequest(body: unknown, token = 'admin-token') {
    return new NextRequest('http://localhost:3000/api/admin/feature-flags', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  }

  function setupAdminAuth(isAdmin = true) {
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_admin' } as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'admin_1',
      email: 'admin@lancepay.com',
      role: isAdmin ? 'admin' : 'user',
    } as any)
  }

  it('allows admin to create a feature flag with structured cohort rules', async () => {
    setupAdminAuth(true)

    const payload = {
      key: 'instant_payouts_v2',
      name: 'Instant Payouts V2',
      description: 'Rollout of next-gen instant payouts',
      enabled: true,
      cohortRules: [
        {
          field: 'country',
          operator: 'in',
          value: ['NG', 'KE', 'GH'],
        },
        {
          field: 'role',
          operator: 'equals',
          value: 'verified_user',
        },
        {
          field: 'isKycVerified',
          operator: 'equals',
          value: true,
        },
      ],
    }

    vi.mocked(prisma.featureFlag.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.featureFlag.create).mockResolvedValue({
      id: 'flag_123',
      key: 'instant_payouts_v2',
      name: payload.name,
      description: payload.description,
      cohortRules: payload.cohortRules,
      enabled: true,
      archived: false,
      createdById: 'admin_1',
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: {
        id: 'admin_1',
        email: 'admin@lancepay.com',
      },
    } as any)

    const req = makeRequest(payload)
    const res = await POST(req)
    const json = await res.json()

    expect(res.status).toBe(201)
    expect(json.featureFlag.key).toBe('instant_payouts_v2')
    expect(json.featureFlag.createdById).toBe('admin_1')
    expect(prisma.featureFlag.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          key: 'instant_payouts_v2',
          createdById: 'admin_1',
          enabled: true,
          cohortRules: payload.cohortRules,
        }),
      }),
    )
  })

  it('rejects cohort rules referencing fields the evaluator cannot read', async () => {
    setupAdminAuth(true)

    const payload = {
      key: 'credit_score_boost',
      name: 'Credit Score Boost',
      cohortRules: [
        {
          field: 'creditScore', // Not an evaluator-supported field
          operator: 'greater_than',
          value: 700,
        },
      ],
    }

    const req = makeRequest(payload)
    const res = await POST(req)
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.code).toBe('UNSUPPORTED_EVALUATOR_FIELD')
    expect(json.unsupportedField).toBe('creditScore')
    expect(prisma.featureFlag.create).not.toHaveBeenCalled()
  })

  it('rejects reusing a flag key that already exists as active', async () => {
    setupAdminAuth(true)

    vi.mocked(prisma.featureFlag.findFirst).mockResolvedValue({
      id: 'existing_flag',
      key: 'crypto_payments',
      archived: false,
    } as any)

    const req = makeRequest({
      key: 'crypto_payments',
      name: 'Crypto Payments',
    })
    const res = await POST(req)
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.code).toBe('FLAG_KEY_EXISTS')
    expect(prisma.featureFlag.create).not.toHaveBeenCalled()
  })

  it('rejects reusing a flag key even if previous flag has been archived', async () => {
    setupAdminAuth(true)

    vi.mocked(prisma.featureFlag.findFirst).mockResolvedValue({
      id: 'archived_flag',
      key: 'legacy_flow',
      archived: true,
    } as any)

    const req = makeRequest({
      key: 'legacy_flow',
      name: 'Legacy Flow Re-use',
    })
    const res = await POST(req)
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.code).toBe('FLAG_KEY_EXISTS')
    expect(json.archived).toBe(true)
    expect(prisma.featureFlag.create).not.toHaveBeenCalled()
  })

  it('rejects non-admin actor with 403 Forbidden', async () => {
    setupAdminAuth(false) // Regular user

    const req = makeRequest({
      key: 'test_flag',
      name: 'Test Flag',
    })
    const res = await POST(req)
    expect(res.status).toBe(403)
    expect(prisma.featureFlag.create).not.toHaveBeenCalled()
  })

  it('rejects unauthenticated request with 403 Forbidden', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)

    const req = makeRequest({ key: 'test_flag', name: 'Test' }, '')
    const res = await POST(req)
    expect(res.status).toBe(403)
  })

  it('rejects invalid key formats with 400', async () => {
    setupAdminAuth(true)

    const req = makeRequest({
      key: 'INVALID KEY WITH SPACES!',
      name: 'Test',
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('rejects malformed JSON body with 400', async () => {
    setupAdminAuth(true)

    const req = makeRequest('not-json')
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('returns 500 on internal database failure', async () => {
    setupAdminAuth(true)
    vi.mocked(prisma.featureFlag.findFirst).mockRejectedValue(new Error('DB connection failed'))

    const req = makeRequest({
      key: 'error_flag',
      name: 'Error Flag',
    })
    const res = await POST(req)
    expect(res.status).toBe(500)
  })
})
