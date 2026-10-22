import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    kycApplication: { findMany: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))
vi.mock('@/lib/kyc-config', () => ({
  KYC_REVIEW_SLA_WINDOW_MS: 5 * 24 * 60 * 60 * 1000, // 5 days
}))

import { GET } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const SLA_WINDOW_MS = 5 * 24 * 60 * 60 * 1000

function makeRequest(authHeader: string = 'Bearer valid-token') {
  const headers: Record<string, string> = {}
  if (authHeader) {
    headers.authorization = authHeader
  }
  return new NextRequest('http://localhost/api/kyc-applications/sla-breaches', {
    method: 'GET',
    headers,
  })
}

async function call(authHeader: string = 'Bearer valid-token') {
  const res = await GET(makeRequest(authHeader))
  return { res, body: await res.json() }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-03-15T12:00:00.000Z'))
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-admin' } as never)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'admin-1', role: 'admin' } as never)
  vi.mocked(prisma.kycApplication.findMany).mockResolvedValue([] as never)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('GET /api/kyc-applications/sla-breaches', () => {
  describe('authentication and access control', () => {
    it('returns 401 without authorization header', async () => {
      const { res, body } = await call('')
      expect(res.status).toBe(401)
      expect(body).toEqual({ error: 'Unauthorized' })
      expect(prisma.kycApplication.findMany).not.toHaveBeenCalled()
    })

    it('returns 401 for invalid token', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue(null as never)
      const { res, body } = await call()
      expect(res.status).toBe(401)
      expect(body).toEqual({ error: 'Invalid token' })
    })

    it('returns 404 when user not found', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never)
      const { res, body } = await call()
      expect(res.status).toBe(404)
      expect(body).toEqual({ error: 'User not found' })
    })

    it('returns 403 for freelancer role', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1', role: 'freelancer' } as never)
      const { res, body } = await call()
      expect(res.status).toBe(403)
      expect(body).toEqual({ error: 'Forbidden: admin or compliance role required' })
    })

    it('allows admin role access', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'admin-1', role: 'admin' } as never)
      const { res } = await call()
      expect(res.status).toBe(200)
      expect(prisma.kycApplication.findMany).toHaveBeenCalled()
    })

    it('allows compliance role access', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'compliance-1', role: 'compliance' } as never)
      const { res } = await call()
      expect(res.status).toBe(200)
      expect(prisma.kycApplication.findMany).toHaveBeenCalled()
    })
  })

  it('returns empty list when no breached applications exist', async () => {
    vi.mocked(prisma.kycApplication.findMany).mockResolvedValue([] as never)
    const { res, body } = await call()
    expect(res.status).toBe(200)
    expect(body).toEqual({
      applications: [],
      count: 0,
      slaWindowMs: SLA_WINDOW_MS,
    })
  })

  it('returns pending applications past SLA deadline sorted by severity', async () => {
    const now = new Date('2026-03-15T12:00:00.000Z')
    const breachedBy1Day = new Date(now.getTime() - (6 * 24 * 60 * 60 * 1000))
    const breachedBy5Days = new Date(now.getTime() - (10 * 24 * 60 * 60 * 1000))
    const breachedBy10Days = new Date(now.getTime() - (15 * 24 * 60 * 60 * 1000))

    vi.mocked(prisma.kycApplication.findMany).mockResolvedValue([
      {
        id: 'kyc-1',
        userId: 'user-1',
        status: 'pending',
        level: 'basic',
        fullName: 'Alice',
        submittedAt: breachedBy1Day,
      },
      {
        id: 'kyc-2',
        userId: 'user-2',
        status: 'pending',
        level: 'basic',
        fullName: 'Bob',
        submittedAt: breachedBy5Days,
      },
      {
        id: 'kyc-3',
        userId: 'user-3',
        status: 'pending',
        level: 'basic',
        fullName: 'Charlie',
        submittedAt: breachedBy10Days,
      },
    ] as never)

    const { res, body } = await call()
    expect(res.status).toBe(200)
    expect(body.applications).toHaveLength(3)
    expect(body.count).toBe(3)

    // Verify sorted by overdueByMs descending (most overdue first)
    expect(body.applications[0].id).toBe('kyc-3') // Most overdue
    expect(body.applications[0].overdueByMs).toBeGreaterThan(body.applications[1].overdueByMs)
    expect(body.applications[1].id).toBe('kyc-2')
    expect(body.applications[1].overdueByMs).toBeGreaterThan(body.applications[2].overdueByMs)
    expect(body.applications[2].id).toBe('kyc-1') // Least overdue
  })

  it('excludes pending applications not yet breached SLA', async () => {
    const now = new Date('2026-03-15T12:00:00.000Z')
    const withinSla = new Date(now.getTime() - (2 * 24 * 60 * 60 * 1000)) // 2 days old
    const breached = new Date(now.getTime() - (6 * 24 * 60 * 60 * 1000)) // 6 days old

    vi.mocked(prisma.kycApplication.findMany).mockResolvedValue([
      {
        id: 'kyc-within',
        userId: 'user-within',
        status: 'pending',
        level: 'basic',
        fullName: 'Within SLA',
        submittedAt: withinSla,
      },
      {
        id: 'kyc-breached',
        userId: 'user-breached',
        status: 'pending',
        level: 'basic',
        fullName: 'Breached',
        submittedAt: breached,
      },
    ] as never)

    const { res, body } = await call()
    expect(res.status).toBe(200)
    expect(body.applications).toHaveLength(1)
    expect(body.applications[0].id).toBe('kyc-breached')
  })

  it('excludes applications with null submittedAt', async () => {
    const now = new Date('2026-03-15T12:00:00.000Z')
    const breached = new Date(now.getTime() - (10 * 24 * 60 * 60 * 1000))

    vi.mocked(prisma.kycApplication.findMany).mockResolvedValue([
      {
        id: 'kyc-no-submit',
        userId: 'user-no-submit',
        status: 'pending',
        level: 'basic',
        fullName: 'No Submit Time',
        submittedAt: null,
      },
      {
        id: 'kyc-with-submit',
        userId: 'user-with-submit',
        status: 'pending',
        level: 'basic',
        fullName: 'With Submit Time',
        submittedAt: breached,
      },
    ] as never)

    const { res, body } = await call()
    expect(res.status).toBe(200)
    expect(body.applications).toHaveLength(1)
    expect(body.applications[0].id).toBe('kyc-with-submit')
  })

  it('excludes application exactly at SLA deadline (boundary)', async () => {
    const now = new Date('2026-03-15T12:00:00.000Z')
    const exactlyAtDeadline = new Date(now.getTime() - SLA_WINDOW_MS)

    vi.mocked(prisma.kycApplication.findMany).mockResolvedValue([
      {
        id: 'kyc-boundary',
        userId: 'user-boundary',
        status: 'pending',
        level: 'basic',
        fullName: 'At Deadline',
        submittedAt: exactlyAtDeadline,
      },
    ] as never)

    const { res, body } = await call()
    expect(res.status).toBe(200)
    expect(body.applications).toHaveLength(0)
    expect(body.count).toBe(0)
  })

  it('calculates overdueByMs correctly', async () => {
    const now = new Date('2026-03-15T12:00:00.000Z')
    const breachedBy1Day = new Date(now.getTime() - (SLA_WINDOW_MS + 24 * 60 * 60 * 1000))

    vi.mocked(prisma.kycApplication.findMany).mockResolvedValue([
      {
        id: 'kyc-calc-test',
        userId: 'user-calc',
        status: 'pending',
        level: 'basic',
        fullName: 'Calc Test',
        submittedAt: breachedBy1Day,
      },
    ] as never)

    const { res, body } = await call()
    expect(res.status).toBe(200)

    const app = body.applications[0]
    expect(app).toHaveProperty('id')
    expect(app).toHaveProperty('userId')
    expect(app).toHaveProperty('status')
    expect(app).toHaveProperty('level')
    expect(app).toHaveProperty('fullName')
    expect(app).toHaveProperty('submittedAt')
    expect(app).toHaveProperty('slaDeadline')
    expect(app).toHaveProperty('overdueByMs')

    // Verify overdueByMs is approximately 1 day
    const expectedOverdueMs = 24 * 60 * 60 * 1000
    expect(Math.abs(app.overdueByMs - expectedOverdueMs)).toBeLessThan(100)
  })

  it('queries only pending applications', async () => {
    vi.mocked(prisma.kycApplication.findMany).mockResolvedValue([] as never)
    await call()

    expect(prisma.kycApplication.findMany).toHaveBeenCalledWith({
      where: { status: 'pending' },
      select: {
        id: true,
        userId: true,
        status: true,
        level: true,
        fullName: true,
        submittedAt: true,
      },
    })
  })

  it('handles database error gracefully with 500 status', async () => {
    vi.mocked(prisma.kycApplication.findMany).mockRejectedValue(new Error('Database error'))
    const { res, body } = await call()
    expect(res.status).toBe(500)
    expect(body).toEqual({ error: 'Internal Server Error' })
  })
})
