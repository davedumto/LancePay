import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { mockPrisma, mockVerifyAuthToken } = vi.hoisted(() => ({
  mockPrisma: {
    user: {
      findUnique: vi.fn(),
    },
    featureFlag: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    featureFlagRevision: {
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

import { PATCH } from './route'

function makePatchRequest(
  key: string,
  body: unknown,
  token: string | null = 'admin-token',
): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest(
    `http://localhost/api/admin/feature-flags/${key}`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    },
  )
}

describe('PATCH /api/admin/feature-flags/[key]', () => {
  const initialChangeEntry = {
    version: 1,
    changedAt: '2026-04-01T00:00:00.000Z',
    changedByAdminId: 'admin-0',
    previousConfig: null,
    newConfig: {
      enabled: true,
      rolloutPercentage: 25,
      cohortRules: [{ field: 'countryCode', operator: 'in', value: ['NG'] }],
      version: 1,
      concurrencyToken: 'v1_initial',
    },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({
      userId: 'admin-1',
      email: 'admin@lancepay.io',
      role: 'admin',
    })
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'admin-1',
      email: 'admin@lancepay.io',
      role: 'admin',
    })
    mockPrisma.featureFlag.findUnique.mockResolvedValue({
      key: 'instant_usdc_settlement',
      enabled: true,
      rolloutPercentage: 25,
      cohortRules: [{ field: 'countryCode', operator: 'in', value: ['NG'] }],
      version: 1,
      concurrencyToken: 'v1_initial',
      changeHistory: [initialChangeEntry],
    })
  })

  it('requires an optimistic concurrency token (400 if missing) and rejects stale tokens with 409', async () => {
    const missingTokenRes = await PATCH(
      makePatchRequest('instant_usdc_settlement', {
        rolloutPercentage: 50,
      }),
      { params: { key: 'instant_usdc_settlement' } },
    )
    expect(missingTokenRes.status).toBe(400)
    expect((await missingTokenRes.json()).code).toBe(
      'CONCURRENCY_TOKEN_REQUIRED',
    )

    const staleTokenRes = await PATCH(
      makePatchRequest('instant_usdc_settlement', {
        rolloutPercentage: 50,
        concurrencyToken: 'v0_stale',
      }),
      { params: { key: 'instant_usdc_settlement' } },
    )
    expect(staleTokenRes.status).toBe(409)
    const staleBody = await staleTokenRes.json()
    expect(staleBody.code).toBe('STALE_CONCURRENCY_TOKEN')
    expect(staleBody.currentConcurrencyToken).toBe('v1_initial')
    expect(mockPrisma.featureFlag.update).not.toHaveBeenCalled()
  })

  it('rejects rolloutPercentage decreases with 403 unless the caller holds the rollback role', async () => {
    // Standard admin without rollback role attempts to shrink rollout from 25% to 10%
    const deniedRes = await PATCH(
      makePatchRequest('instant_usdc_settlement', {
        rolloutPercentage: 10,
        concurrencyToken: 'v1_initial',
      }),
      { params: { key: 'instant_usdc_settlement' } },
    )
    expect(deniedRes.status).toBe(403)
    const deniedBody = await deniedRes.json()
    expect(deniedBody.code).toBe('ROLLBACK_ROLE_REQUIRED')
    expect(deniedBody.previousPercentage).toBe(25)
    expect(deniedBody.requestedPercentage).toBe(10)
    expect(mockPrisma.featureFlag.update).not.toHaveBeenCalled()

    // Admin with rollback_admin role is permitted to decrease rolloutPercentage
    mockVerifyAuthToken.mockResolvedValueOnce({
      userId: 'rollback-1',
      email: 'release@lancepay.io',
      role: 'rollback_admin',
    })
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'rollback-1',
      email: 'release@lancepay.io',
      role: 'rollback_admin',
    })
    mockPrisma.featureFlagRevision.create.mockResolvedValueOnce({
      id: 'rev-2',
    })
    mockPrisma.featureFlag.update.mockImplementationOnce(async ({ data }) => ({
      key: 'instant_usdc_settlement',
      ...data,
    }))

    const allowedRes = await PATCH(
      makePatchRequest('instant_usdc_settlement', {
        rolloutPercentage: 10,
        concurrencyToken: 'v1_initial',
        reason: 'Canary latency regression rollback',
      }),
      { params: { key: 'instant_usdc_settlement' } },
    )
    expect(allowedRes.status).toBe(200)
    const allowedBody = await allowedRes.json()
    expect(allowedBody.featureFlag.rolloutPercentage).toBe(10)
    expect(allowedBody.featureFlag.version).toBe(2)
  })

  it('appends a change entry rather than overwriting prior configuration so the full history is recoverable', async () => {
    mockPrisma.featureFlagRevision.create.mockResolvedValueOnce({
      id: 'rev-2',
    })
    mockPrisma.featureFlag.update.mockImplementationOnce(async ({ data }) => ({
      key: 'instant_usdc_settlement',
      ...data,
    }))

    const res = await PATCH(
      makePatchRequest('instant_usdc_settlement', {
        rolloutPercentage: 50,
        concurrencyToken: 'v1_initial',
        reason: 'Expand rollout to 50% of NG cohort',
      }),
      { params: { key: 'instant_usdc_settlement' } },
    )
    expect(res.status).toBe(200)
    const body = await res.json()

    // Full history contains both v1 and the newly appended v2 entry
    expect(body.featureFlag.changeHistory).toHaveLength(2)
    expect(body.featureFlag.changeHistory[0]).toEqual(initialChangeEntry)
    expect(body.featureFlag.changeHistory[1].version).toBe(2)
    expect(
      body.featureFlag.changeHistory[1].previousConfig.rolloutPercentage,
    ).toBe(25)
    expect(body.featureFlag.changeHistory[1].newConfig.rolloutPercentage).toBe(
      50,
    )

    expect(mockPrisma.featureFlagRevision.create).toHaveBeenCalledOnce()
    const revArg = mockPrisma.featureFlagRevision.create.mock.calls[0][0].data
    expect(revArg.previousConfig.rolloutPercentage).toBe(25)
    expect(revArg.newConfig.rolloutPercentage).toBe(50)
  })
})
