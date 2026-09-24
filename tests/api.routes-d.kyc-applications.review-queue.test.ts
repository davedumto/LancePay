import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const kycApplicationFindMany = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    kycApplication: { findMany: kycApplicationFindMany },
  },
}))

const BASE_URL = 'http://localhost/api/routes-d/kyc-applications/review-queue'

function makeRequest(authHeader: string = 'Bearer valid-token') {
  const headers: Record<string, string> = {}
  if (authHeader) {
    headers.authorization = authHeader
  }

  return new NextRequest(BASE_URL, {
    method: 'GET',
    headers,
  })
}

describe('GET /api/routes-d/kyc-applications/review-queue', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ─────────────────────────────────────────────────────────────────────
  // Authorization failure scenarios
  // ─────────────────────────────────────────────────────────────────────

  it('returns 401 when authorization header is missing', async () => {
    const { GET } = await import('@/app/api/routes-d/kyc-applications/review-queue/route')
    const res = await GET(makeRequest(''))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Unauthorized')
  })

  it('returns 401 when token is invalid', async () => {
    verifyAuthToken.mockResolvedValue(null)

    const { GET } = await import('@/app/api/routes-d/kyc-applications/review-queue/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Invalid token')
  })

  it('returns 404 when user profile is not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(null)

    const { GET } = await import('@/app/api/routes-d/kyc-applications/review-queue/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('User not found')
  })

  it('returns 403 when user role is not admin or compliance', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1', role: 'freelancer' })

    const { GET } = await import('@/app/api/routes-d/kyc-applications/review-queue/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('Forbidden: admin or compliance role required')
  })

  // ─────────────────────────────────────────────────────────────────────
  // Test Scenario 4: Empty state (no pending applications)
  // ─────────────────────────────────────────────────────────────────────

  it('returns empty list when no pending applications exist', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_admin' })
    userFindUnique.mockResolvedValue({ id: 'admin_1', role: 'admin' })
    kycApplicationFindMany.mockResolvedValue([])

    const { GET } = await import('@/app/api/routes-d/kyc-applications/review-queue/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.applications).toEqual([])
    expect(body.count).toBe(0)
    expect(body.slaWindowMs).toBeDefined()
  })

  // ─────────────────────────────────────────────────────────────────────
  // Test Scenario 1: Happy path with varying SLA urgencies
  // ─────────────────────────────────────────────────────────────────────

  it('returns pending applications sorted by SLA urgency (most urgent first)', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_admin' })
    userFindUnique.mockResolvedValue({ id: 'admin_1', role: 'admin' })

    // Create 3 applications with different submission times
    const now = new Date()
    const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000) // 14 days ago (past SLA)
    const threeWeeksAgo = new Date(now.getTime() - 21 * 24 * 60 * 60 * 1000) // 21 days ago (well past SLA)
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000) // 2 days ago (not past SLA yet)

    kycApplicationFindMany.mockResolvedValue([
      {
        id: 'kyc_1',
        userId: 'user_1',
        status: 'pending',
        level: 'basic',
        fullName: 'Alice Smith',
        submittedAt: twoDaysAgo, // Not breached
      },
      {
        id: 'kyc_2',
        userId: 'user_2',
        status: 'pending',
        level: 'basic',
        fullName: 'Bob Johnson',
        submittedAt: twoWeeksAgo, // Breached by ~9 days
      },
      {
        id: 'kyc_3',
        userId: 'user_3',
        status: 'pending',
        level: 'basic',
        fullName: 'Charlie Brown',
        submittedAt: threeWeeksAgo, // Breached by ~16 days
      },
    ])

    const { GET } = await import('@/app/api/routes-d/kyc-applications/review-queue/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.applications).toHaveLength(3)
    expect(body.count).toBe(3)

    // Verify they are sorted by urgency (most urgent first)
    // Order should be: kyc_3 (most breached), kyc_2 (less breached), kyc_1 (least urgent)
    expect(body.applications[0].id).toBe('kyc_3')
    expect(body.applications[0].breached).toBe(true)
    expect(body.applications[0].timeRemainingMs).toBeLessThan(0)

    expect(body.applications[1].id).toBe('kyc_2')
    expect(body.applications[1].breached).toBe(true)
    expect(body.applications[1].timeRemainingMs).toBeLessThan(0)
    expect(body.applications[1].timeRemainingMs).toBeGreaterThan(body.applications[0].timeRemainingMs)

    expect(body.applications[2].id).toBe('kyc_1')
    expect(body.applications[2].breached).toBe(false)
    expect(body.applications[2].timeRemainingMs).toBeGreaterThan(0)
  })

  // ─────────────────────────────────────────────────────────────────────
  // Test Scenario 2: Application exactly at SLA deadline
  // ─────────────────────────────────────────────────────────────────────

  it('handles application exactly at SLA deadline (timeRemainingMs == 0)', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_compliance' })
    userFindUnique.mockResolvedValue({ id: 'compliance_1', role: 'compliance' })

    // Simulate an application submitted exactly 5 days ago (with 5-day SLA)
    // This requires mocking the current time to be exactly at the deadline
    const SLA_WINDOW_MS = 5 * 24 * 60 * 60 * 1000
    const submittedAt = new Date(Date.now() - SLA_WINDOW_MS)

    kycApplicationFindMany.mockResolvedValue([
      {
        id: 'kyc_boundary',
        userId: 'user_boundary',
        status: 'pending',
        level: 'basic',
        fullName: 'Boundary Test',
        submittedAt,
      },
    ])

    const { GET } = await import('@/app/api/routes-d/kyc-applications/review-queue/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.applications).toHaveLength(1)

    const app = body.applications[0]
    expect(app.id).toBe('kyc_boundary')
    // timeRemainingMs should be very close to 0 (allowing for small timing variations)
    expect(Math.abs(app.timeRemainingMs)).toBeLessThan(1000) // within 1 second
  })

  // ─────────────────────────────────────────────────────────────────────
  // Test Scenario 3: Already-breached application sorts first
  // ─────────────────────────────────────────────────────────────────────

  it('sorts breached applications above non-breached ones', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_admin' })
    userFindUnique.mockResolvedValue({ id: 'admin_1', role: 'admin' })

    const now = new Date()
    const breachedByManyDays = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000) // 20 days ago
    const breachedByFewDays = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000) // 6 days ago
    const notBreached = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000) // 3 days ago

    kycApplicationFindMany.mockResolvedValue([
      {
        id: 'kyc_not_breached',
        userId: 'user_nb',
        status: 'pending',
        level: 'basic',
        fullName: 'Not Breached',
        submittedAt: notBreached,
      },
      {
        id: 'kyc_breached_few',
        userId: 'user_bf',
        status: 'pending',
        level: 'basic',
        fullName: 'Breached Few Days',
        submittedAt: breachedByFewDays,
      },
      {
        id: 'kyc_breached_many',
        userId: 'user_bm',
        status: 'pending',
        level: 'basic',
        fullName: 'Breached Many Days',
        submittedAt: breachedByManyDays,
      },
    ])

    const { GET } = await import('@/app/api/routes-d/kyc-applications/review-queue/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.applications).toHaveLength(3)

    // First application should be the one most breached
    expect(body.applications[0].id).toBe('kyc_breached_many')
    expect(body.applications[0].breached).toBe(true)

    // Second should be less breached
    expect(body.applications[1].id).toBe('kyc_breached_few')
    expect(body.applications[1].breached).toBe(true)

    // Last should be not breached
    expect(body.applications[2].id).toBe('kyc_not_breached')
    expect(body.applications[2].breached).toBe(false)
  })

  // ─────────────────────────────────────────────────────────────────────
  // Test Scenario 6: Database/query failure gracefully handled
  // ─────────────────────────────────────────────────────────────────────

  it('handles database error gracefully with 500 status', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_admin' })
    userFindUnique.mockResolvedValue({ id: 'admin_1', role: 'admin' })
    kycApplicationFindMany.mockRejectedValue(new Error('Database connection failed'))

    const { GET } = await import('@/app/api/routes-d/kyc-applications/review-queue/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(500)

    const body = await res.json()
    expect(body.error).toBe('Internal Server Error')
  })

  // ─────────────────────────────────────────────────────────────────────
  // Additional test: compliance role can access
  // ─────────────────────────────────────────────────────────────────────

  it('allows compliance role to access review queue', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_compliance' })
    userFindUnique.mockResolvedValue({ id: 'compliance_1', role: 'compliance' })
    kycApplicationFindMany.mockResolvedValue([])

    const { GET } = await import('@/app/api/routes-d/kyc-applications/review-queue/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
  })

  // ─────────────────────────────────────────────────────────────────────
  // Additional test: handles applications with null submittedAt
  // ─────────────────────────────────────────────────────────────────────

  it('handles applications with null submittedAt', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_admin' })
    userFindUnique.mockResolvedValue({ id: 'admin_1', role: 'admin' })

    kycApplicationFindMany.mockResolvedValue([
      {
        id: 'kyc_no_submit',
        userId: 'user_no_submit',
        status: 'pending',
        level: 'basic',
        fullName: 'No Submit Time',
        submittedAt: null,
      },
      {
        id: 'kyc_with_submit',
        userId: 'user_with_submit',
        status: 'pending',
        level: 'basic',
        fullName: 'With Submit Time',
        submittedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      },
    ])

    const { GET } = await import('@/app/api/routes-d/kyc-applications/review-queue/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.applications).toHaveLength(2)

    // Application with submittedAt should come first
    expect(body.applications[0].id).toBe('kyc_with_submit')
    expect(body.applications[0].timeRemainingMs).not.toBeNull()

    // Application without submittedAt should come last
    expect(body.applications[1].id).toBe('kyc_no_submit')
    expect(body.applications[1].submittedAt).toBeNull()
    expect(body.applications[1].timeRemainingMs).toBeNull()
  })

  // ─────────────────────────────────────────────────────────────────────
  // Additional test: verifies response structure
  // ─────────────────────────────────────────────────────────────────────

  it('returns correct response structure with all required fields', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_admin' })
    userFindUnique.mockResolvedValue({ id: 'admin_1', role: 'admin' })

    const now = new Date()
    const submittedAt = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000)

    kycApplicationFindMany.mockResolvedValue([
      {
        id: 'kyc_structure_test',
        userId: 'user_structure',
        status: 'pending',
        level: 'basic',
        fullName: 'Structure Test',
        submittedAt,
      },
    ])

    const { GET } = await import('@/app/api/routes-d/kyc-applications/review-queue/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body).toHaveProperty('applications')
    expect(body).toHaveProperty('count')
    expect(body).toHaveProperty('slaWindowMs')

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

    // Verify types
    expect(typeof app.id).toBe('string')
    expect(typeof app.userId).toBe('string')
    expect(typeof app.timeRemainingMs).toBe('number')
    expect(typeof app.breached).toBe('boolean')
  })
})
