import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GET } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    kycApplication: { findMany: vi.fn() },
  },
}))

vi.mock('@/lib/kyc-config', () => ({
  KYC_REVIEW_SLA_WINDOW_MS: 5 * 24 * 60 * 60 * 1000, // 5 days
  KYC_STATUS_PENDING: 'pending',
  getTimeRemainingMs: (submittedAt: Date, now: number) => {
    const deadline = submittedAt.getTime() + 5 * 24 * 60 * 60 * 1000
    return deadline - now
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'

function makeRequest(token: string | null = 'valid-token'): NextRequest {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (token) headers.set('authorization', `Bearer ${token}`)

  return new NextRequest('http://localhost/api/kyc-applications/review-queue', {
    method: 'GET',
    headers,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/kyc-applications/review-queue', () => {
  describe('Authentication', () => {
    it('returns 401 when not authenticated', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue(null)

      const res = await GET(makeRequest(null))
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('Unauthorized')
    })

    it('returns 401 when token verification fails', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue(null)

      const res = await GET(makeRequest('invalid-token'))
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('Invalid token')
    })

    it('returns 404 when user not found', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_unknown' })
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null)

      const res = await GET(makeRequest())
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toBe('User not found')
    })
  })

  describe('Authorization', () => {
    beforeEach(() => {
      vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_1' })
    })

    it('allows admin users', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user_1', role: 'admin' })
      vi.mocked(prisma.kycApplication.findMany).mockResolvedValue([])

      const res = await GET(makeRequest())
      expect(res.status).toBe(200)
    })

    it('allows compliance users', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user_1', role: 'compliance' })
      vi.mocked(prisma.kycApplication.findMany).mockResolvedValue([])

      const res = await GET(makeRequest())
      expect(res.status).toBe(200)
    })

    it('denies non-admin/non-compliance users', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user_1', role: 'freelancer' })

      const res = await GET(makeRequest())
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.error).toContain('admin or compliance role required')
    })

    it('denies users with other roles', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user_1', role: 'user' })

      const res = await GET(makeRequest())
      expect(res.status).toBe(403)
    })
  })

  describe('Pending applications query', () => {
    beforeEach(() => {
      vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_1' })
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user_1', role: 'admin' })
    })

    it('queries for pending status applications only', async () => {
      vi.mocked(prisma.kycApplication.findMany).mockResolvedValue([])

      await GET(makeRequest())

      const findManyCall = vi.mocked(prisma.kycApplication.findMany).mock.calls[0][0]
      expect(findManyCall.where.status).toBe('pending')
    })

    it('returns empty array when no pending applications', async () => {
      vi.mocked(prisma.kycApplication.findMany).mockResolvedValue([])

      const res = await GET(makeRequest())
      expect(res.status).toBe(200)
      const body = await res.json()

      expect(body.applications).toEqual([])
      expect(body.count).toBe(0)
    })
  })

  describe('SLA calculations', () => {
    beforeEach(() => {
      vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_1' })
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user_1', role: 'admin' })
    })

    it('computes slaDeadline and timeRemainingMs for applications with submittedAt', async () => {
      const submittedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) // 2 days ago
      vi.mocked(prisma.kycApplication.findMany).mockResolvedValue([
        {
          id: 'app_1',
          userId: 'user_1',
          status: 'pending',
          level: 'basic',
          fullName: 'John Doe',
          submittedAt,
        },
      ])

      const res = await GET(makeRequest())
      expect(res.status).toBe(200)
      const body = await res.json()

      expect(body.applications).toHaveLength(1)
      const app = body.applications[0]
      expect(app.submittedAt).toBeDefined()
      expect(app.slaDeadline).toBeDefined()
      expect(app.timeRemainingMs).toBeDefined()
      expect(typeof app.timeRemainingMs).toBe('number')
    })

    it('marks application as breached when timeRemainingMs is negative', async () => {
      const submittedAt = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000) // 6 days ago (past 5-day SLA)
      vi.mocked(prisma.kycApplication.findMany).mockResolvedValue([
        {
          id: 'app_1',
          userId: 'user_1',
          status: 'pending',
          level: 'basic',
          fullName: 'John Doe',
          submittedAt,
        },
      ])

      const res = await GET(makeRequest())
      const body = await res.json()

      expect(body.applications[0].breached).toBe(true)
      expect(body.applications[0].timeRemainingMs).toBeLessThan(0)
    })

    it('marks application as not breached when timeRemainingMs is positive', async () => {
      const submittedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) // 2 days ago (within 5-day SLA)
      vi.mocked(prisma.kycApplication.findMany).mockResolvedValue([
        {
          id: 'app_1',
          userId: 'user_1',
          status: 'pending',
          level: 'basic',
          fullName: 'John Doe',
          submittedAt,
        },
      ])

      const res = await GET(makeRequest())
      const body = await res.json()

      expect(body.applications[0].breached).toBe(false)
      expect(body.applications[0].timeRemainingMs).toBeGreaterThan(0)
    })

    it('handles applications with null submittedAt', async () => {
      vi.mocked(prisma.kycApplication.findMany).mockResolvedValue([
        {
          id: 'app_1',
          userId: 'user_1',
          status: 'pending',
          level: 'basic',
          fullName: 'Jane Doe',
          submittedAt: null,
        },
      ])

      const res = await GET(makeRequest())
      const body = await res.json()

      expect(body.applications[0].submittedAt).toBeNull()
      expect(body.applications[0].slaDeadline).toBeNull()
      expect(body.applications[0].timeRemainingMs).toBeNull()
      expect(body.applications[0].breached).toBe(false)
    })
  })

  describe('Sorting by urgency', () => {
    beforeEach(() => {
      vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_1' })
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user_1', role: 'admin' })
    })

    it('sorts applications with breached appearing first', async () => {
      const now = Date.now()
      const breachedApp = new Date(now - 6 * 24 * 60 * 60 * 1000) // 6 days ago
      const urgentApp = new Date(now - 4.5 * 24 * 60 * 60 * 1000) // 4.5 days ago
      const safeApp = new Date(now - 1 * 24 * 60 * 60 * 1000) // 1 day ago

      vi.mocked(prisma.kycApplication.findMany).mockResolvedValue([
        {
          id: 'app_safe',
          userId: 'user_1',
          status: 'pending',
          level: 'basic',
          fullName: 'Safe',
          submittedAt: safeApp,
        },
        {
          id: 'app_breached',
          userId: 'user_2',
          status: 'pending',
          level: 'basic',
          fullName: 'Breached',
          submittedAt: breachedApp,
        },
        {
          id: 'app_urgent',
          userId: 'user_3',
          status: 'pending',
          level: 'basic',
          fullName: 'Urgent',
          submittedAt: urgentApp,
        },
      ])

      const res = await GET(makeRequest())
      const body = await res.json()

      expect(body.applications).toHaveLength(3)
      // Breached should be first (most negative timeRemainingMs)
      expect(body.applications[0].id).toBe('app_breached')
      expect(body.applications[0].breached).toBe(true)
      // Urgent should be second (least positive timeRemainingMs)
      expect(body.applications[1].id).toBe('app_urgent')
      expect(body.applications[1].breached).toBe(false)
      // Safe should be last (most positive timeRemainingMs)
      expect(body.applications[2].id).toBe('app_safe')
    })

    it('places null submittedAt applications at the end', async () => {
      const submittedApp = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)

      vi.mocked(prisma.kycApplication.findMany).mockResolvedValue([
        {
          id: 'app_with_time',
          userId: 'user_1',
          status: 'pending',
          level: 'basic',
          fullName: 'With Time',
          submittedAt: submittedApp,
        },
        {
          id: 'app_no_time',
          userId: 'user_2',
          status: 'pending',
          level: 'basic',
          fullName: 'No Time',
          submittedAt: null,
        },
      ])

      const res = await GET(makeRequest())
      const body = await res.json()

      expect(body.applications).toHaveLength(2)
      // Non-null should come first
      expect(body.applications[0].id).toBe('app_with_time')
      expect(body.applications[0].submittedAt).not.toBeNull()
      // Null should come last
      expect(body.applications[1].id).toBe('app_no_time')
      expect(body.applications[1].submittedAt).toBeNull()
    })
  })

  describe('Response structure', () => {
    beforeEach(() => {
      vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_1' })
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user_1', role: 'admin' })
    })

    it('returns applications array, count, and slaWindowMs', async () => {
      vi.mocked(prisma.kycApplication.findMany).mockResolvedValue([])

      const res = await GET(makeRequest())
      expect(res.status).toBe(200)
      const body = await res.json()

      expect(body).toHaveProperty('applications')
      expect(body).toHaveProperty('count')
      expect(body).toHaveProperty('slaWindowMs')
      expect(Array.isArray(body.applications)).toBe(true)
      expect(typeof body.count).toBe('number')
      expect(typeof body.slaWindowMs).toBe('number')
    })

    it('includes all required fields for each application', async () => {
      const submittedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
      vi.mocked(prisma.kycApplication.findMany).mockResolvedValue([
        {
          id: 'app_1',
          userId: 'user_1',
          status: 'pending',
          level: 'enhanced',
          fullName: 'John Doe',
          submittedAt,
        },
      ])

      const res = await GET(makeRequest())
      const body = await res.json()

      const app = body.applications[0]
      expect(app).toHaveProperty('id')
      expect(app).toHaveProperty('userId')
      expect(app).toHaveProperty('status')
      expect(app).toHaveProperty('level')
      expect(app).toHaveProperty('fullName')
      expect(app).toHaveProperty('submittedAt')
      expect(app).toHaveProperty('slaDeadline')
      expect(app).toHaveProperty('timeRemainingMs')
      expect(app).toHaveProperty('breached')
    })
  })

  describe('Error handling', () => {
    beforeEach(() => {
      vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_1' })
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user_1', role: 'admin' })
    })

    it('returns 500 on database error', async () => {
      vi.mocked(prisma.kycApplication.findMany).mockRejectedValue(
        new Error('Database connection failed')
      )

      const res = await GET(makeRequest())
      expect(res.status).toBe(500)
      const body = await res.json()
      expect(body.error).toBe('Internal Server Error')
    })

    it('does not expose error details in response', async () => {
      vi.mocked(prisma.kycApplication.findMany).mockRejectedValue(
        new Error('Internal DB error')
      )

      const res = await GET(makeRequest())
      const body = await res.json()

      expect(body.error).not.toContain('Internal DB error')
    })
  })

  describe('Happy path scenarios', () => {
    it('admin retrieves review queue with multiple applications in correct order', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_admin' })
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'admin_1', role: 'admin' })

      const now = Date.now()
      const breachedAt = new Date(now - 6 * 24 * 60 * 60 * 1000)
      const urgentAt = new Date(now - 4.5 * 24 * 60 * 60 * 1000)
      const normalAt = new Date(now - 1 * 24 * 60 * 60 * 1000)

      vi.mocked(prisma.kycApplication.findMany).mockResolvedValue([
        {
          id: 'app_1',
          userId: 'user_1',
          status: 'pending',
          level: 'basic',
          fullName: 'Alice',
          submittedAt: normalAt,
        },
        {
          id: 'app_2',
          userId: 'user_2',
          status: 'pending',
          level: 'basic',
          fullName: 'Bob',
          submittedAt: breachedAt,
        },
        {
          id: 'app_3',
          userId: 'user_3',
          status: 'pending',
          level: 'basic',
          fullName: 'Charlie',
          submittedAt: urgentAt,
        },
      ])

      const res = await GET(makeRequest())
      expect(res.status).toBe(200)
      const body = await res.json()

      expect(body.applications).toHaveLength(3)
      expect(body.count).toBe(3)
      expect(body.slaWindowMs).toBe(5 * 24 * 60 * 60 * 1000)

      // Verify order: breached, urgent, normal
      expect(body.applications[0].fullName).toBe('Bob')
      expect(body.applications[1].fullName).toBe('Charlie')
      expect(body.applications[2].fullName).toBe('Alice')
    })

    it('compliance officer can retrieve review queue', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_comp' })
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'comp_1', role: 'compliance' })

      const submittedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
      vi.mocked(prisma.kycApplication.findMany).mockResolvedValue([
        {
          id: 'app_1',
          userId: 'user_1',
          status: 'pending',
          level: 'enhanced',
          fullName: 'John Doe',
          submittedAt,
        },
      ])

      const res = await GET(makeRequest())
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.applications).toHaveLength(1)
    })
  })
})
