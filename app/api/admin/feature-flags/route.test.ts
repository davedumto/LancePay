import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { mockPrisma, mockVerifyAuthToken } = vi.hoisted(() => ({
  mockPrisma: {
    user: {
      findUnique: vi.fn(),
    },
    featureFlag: {
      findUnique: vi.fn(),
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

import { POST } from './route'

function makePostRequest(
  body: unknown,
  token: string | null = 'admin-token',
): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest('http://localhost/api/admin/feature-flags', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

describe('POST /api/admin/feature-flags', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({
      userId: 'admin-privy-7',
      email: 'platform-owner@lancepay.io',
      role: 'admin',
    })
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'admin-owner-7',
      email: 'platform-owner@lancepay.io',
      role: 'admin',
    })
    mockPrisma.featureFlag.findUnique.mockResolvedValue(null)
  })

  it('validates cohort rule shape against the schema and rejects rules referencing fields the evaluator cannot read', async () => {
    // 1. Rejects rule referencing an unreadable evaluator field (e.g. twoFactorSecret)
    const unreadableFieldRes = await POST(
      makePostRequest({
        key: 'beta_multi_currency',
        rolloutPercentage: 20,
        cohortRules: [
          {
            field: 'twoFactorSecret',
            operator: 'eq',
            value: 'secret',
          },
        ],
      }),
    )
    expect(unreadableFieldRes.status).toBe(400)
    const unreadableBody = await unreadableFieldRes.json()
    expect(unreadableBody.code).toBe('UNREADABLE_EVALUATOR_FIELD')
    expect(unreadableBody.field).toBe('twoFactorSecret')
    expect(mockPrisma.featureFlag.create).not.toHaveBeenCalled()

    // 2. Rejects malformed cohort rule operator/value shape
    const badSchemaRes = await POST(
      makePostRequest({
        key: 'beta_multi_currency',
        rolloutPercentage: 20,
        cohortRules: [
          {
            field: 'trustScore',
            operator: 'gte',
            value: 'not-a-number',
          },
        ],
      }),
    )
    expect(badSchemaRes.status).toBe(400)
    expect((await badSchemaRes.json()).code).toBe('INVALID_COHORT_RULE_SCHEMA')
  })

  it('rejects reusing a flag key that already exists even if the previous flag has been archived', async () => {
    mockPrisma.featureFlag.findUnique.mockResolvedValueOnce({
      id: 'ff-archived-1',
      key: 'legacy_checkout_flow',
      status: 'archived',
      archived: true,
      archivedAt: new Date('2025-12-01T00:00:00Z'),
    })

    const res = await POST(
      makePostRequest({
        key: 'legacy_checkout_flow',
        enabled: true,
        rolloutPercentage: 10,
        cohortRules: [
          {
            field: 'countryCode',
            operator: 'in',
            value: ['NG', 'KE'],
          },
        ],
      }),
    )
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('FLAG_KEY_ALREADY_EXISTS')
    expect(body.wasArchived).toBe(true)
    expect(mockPrisma.featureFlag.create).not.toHaveBeenCalled()
  })

  it('creates a valid feature flag with cohort rules and records the creating admin on the flag for audit traceability', async () => {
    mockPrisma.featureFlag.create.mockImplementationOnce(async ({ data }) => ({
      id: 'ff-new-1',
      ...data,
    }))

    const res = await POST(
      makePostRequest({
        key: 'stellar_sponsored_reserves_v2',
        description: 'Roll out CAP-0033 sponsored reserves to high-trust NG/GH users',
        enabled: true,
        rolloutPercentage: 50,
        cohortRules: [
          {
            field: 'countryCode',
            operator: 'in',
            value: ['NG', 'GH'],
          },
          {
            field: 'trustScore',
            operator: 'gte',
            value: 70,
          },
          {
            field: 'kycVerified',
            operator: 'eq',
            value: true,
          },
        ],
      }),
    )

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.featureFlag.key).toBe('stellar_sponsored_reserves_v2')
    expect(body.featureFlag.createdByAdminId).toBe('admin-owner-7')
    expect(body.featureFlag.createdByEmail).toBe('platform-owner@lancepay.io')
    expect(body.featureFlag.cohortRules).toHaveLength(3)

    expect(mockPrisma.featureFlag.create).toHaveBeenCalledOnce()
    const createArg = mockPrisma.featureFlag.create.mock.calls[0][0].data
    expect(createArg.createdByAdminId).toBe('admin-owner-7')
    expect(createArg.createdByEmail).toBe('platform-owner@lancepay.io')

    expect(mockPrisma.auditLog.create).toHaveBeenCalledOnce()
    expect(mockPrisma.auditLog.create.mock.calls[0][0].data.actorId).toBe(
      'admin-owner-7',
    )
  })
})
