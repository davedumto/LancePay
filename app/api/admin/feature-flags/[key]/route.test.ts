import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { PATCH } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
    featureFlag: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    featureFlagChange: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
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

describe('PATCH /api/admin/feature-flags/[key]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function makeRequest(
    key: string,
    body: unknown,
    headers: Record<string, string> = { authorization: 'Bearer admin-token' },
  ) {
    return {
      req: new NextRequest(`http://localhost:3000/api/admin/feature-flags/${key}`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          ...headers,
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
      params: Promise.resolve({ key }),
    }
  }

  function setupAdmin(role: 'admin' | 'superadmin' | 'user' = 'admin') {
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_admin' } as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'admin_123',
      email: 'admin@lancepay.com',
      role,
    } as any)
  }

  it('updates rollout plan and appends change log entry when concurrency token matches', async () => {
    setupAdmin('admin')

    const initialFlag = {
      id: 'flag_1',
      key: 'new_checkout',
      rolloutPercentage: 20,
      cohortRules: [],
      enabled: true,
      killed: false,
      version: 3,
      changeLog: [],
      updatedAt: new Date('2026-10-18T12:00:00Z'),
    }

    vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue(initialFlag as any)
    vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) => {
      return callback({
        featureFlagChange: { create: vi.fn() },
        featureFlag: {
          update: vi.fn().mockResolvedValue({
            ...initialFlag,
            rolloutPercentage: 50,
            version: 4,
          }),
        },
      })
    })

    const { req, params } = makeRequest('new_checkout', {
      concurrencyToken: 3,
      rolloutPercentage: 50,
      reason: 'Expanding rollout to 50%',
    })

    const res = await PATCH(req, { params })
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.featureFlag.rolloutPercentage).toBe(50)
    expect(json.changeEntry.version).toBe(4)
    expect(json.changeEntry.priorConfig.rolloutPercentage).toBe(20)
    expect(json.changeEntry.newConfig.rolloutPercentage).toBe(50)
  })

  it('rejects stale updates when optimistic concurrency token does not match', async () => {
    setupAdmin('admin')

    vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue({
      id: 'flag_1',
      key: 'new_checkout',
      rolloutPercentage: 20,
      version: 5,
      updatedAt: new Date('2026-10-18T15:00:00Z'),
    } as any)

    const { req, params } = makeRequest('new_checkout', {
      concurrencyToken: 3, // Stale token
      rolloutPercentage: 50,
    })

    const res = await PATCH(req, { params })
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.code).toBe('CONCURRENCY_CONFLICT')
  })

  it('rejects missing concurrency token with 400', async () => {
    setupAdmin('admin')

    const { req, params } = makeRequest('new_checkout', {
      rolloutPercentage: 50,
    })

    const res = await PATCH(req, { params })
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.code).toBe('CONCURRENCY_TOKEN_REQUIRED')
  })

  it('rejects rollout percentage decrease when caller lacks rollback role', async () => {
    setupAdmin('admin') // Regular admin without rollback role

    vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue({
      id: 'flag_1',
      key: 'new_checkout',
      rolloutPercentage: 60,
      version: 2,
      updatedAt: new Date(),
    } as any)

    const { req, params } = makeRequest('new_checkout', {
      concurrencyToken: 2,
      rolloutPercentage: 30, // Attempted decrease from 60 to 30
    })

    const res = await PATCH(req, { params })
    const json = await res.json()

    expect(res.status).toBe(403)
    expect(json.code).toBe('ROLLBACK_ROLE_REQUIRED')
  })

  it('allows rollout percentage decrease when caller holds rollback role', async () => {
    setupAdmin('superadmin') // Superadmin holds rollback privileges

    const initialFlag = {
      id: 'flag_1',
      key: 'new_checkout',
      rolloutPercentage: 60,
      cohortRules: [],
      enabled: true,
      killed: false,
      version: 2,
      changeLog: [],
      updatedAt: new Date(),
    }

    vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue(initialFlag as any)
    vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) => {
      return callback({
        featureFlagChange: { create: vi.fn() },
        featureFlag: {
          update: vi.fn().mockResolvedValue({
            ...initialFlag,
            rolloutPercentage: 20,
            version: 3,
          }),
        },
      })
    })

    const { req, params } = makeRequest('new_checkout', {
      concurrencyToken: 2,
      rolloutPercentage: 20,
      reason: 'Issue detected, rolling back',
    })

    const res = await PATCH(req, { params })
    expect(res.status).toBe(200)
  })

  it('returns 404 when feature flag is not found', async () => {
    setupAdmin('admin')
    vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue(null)

    const { req, params } = makeRequest('unknown_flag', {
      concurrencyToken: 1,
      enabled: false,
    })

    const res = await PATCH(req, { params })
    expect(res.status).toBe(404)
  })

  it('rejects non-admin caller with 403', async () => {
    setupAdmin('user')

    const { req, params } = makeRequest('new_checkout', { concurrencyToken: 1 })
    const res = await PATCH(req, { params })
    expect(res.status).toBe(403)
  })

  it('returns 500 when database throws', async () => {
    setupAdmin('admin')
    vi.mocked(prisma.featureFlag.findUnique).mockRejectedValue(new Error('DB failure'))

    const { req, params } = makeRequest('new_checkout', { concurrencyToken: 1 })
    const res = await PATCH(req, { params })
    expect(res.status).toBe(500)
  })
})
