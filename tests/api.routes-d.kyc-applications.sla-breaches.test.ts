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

const BASE_URL = 'http://localhost/api/routes-d/kyc-applications/sla-breaches'

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

describe('GET /api/routes-d/kyc-applications/sla-breaches', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ─────────────────────────────────────────────────────────────────────
  // Authorization failure scenarios (tests 6 & 7)
  // ─────────────────────────────────────────────────────────────────────

  it('returns 401 when authorization header is missing', async () => {
    const { GET } = await import('@/app/api/routes-d/kyc-applications/sla-breaches/route')
    const res = await GET(makeRequest(''))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Unauthorized')
  })

  it('returns 401 when token is invalid', async () => {
    verifyAuthToken.mockResolvedValue(null)

    const { GET } = await import('@/app/api/routes-d/kyc-applications/sla-breaches/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Invalid token')
  })

  it('returns 404 when user profile is not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(null)

    const { GET } = await import('@/app/api/routes-d/kyc-applications/sla-breaches/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('User not found')
  })

  it('returns 403 when user role is not admin or compliance', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1', role: 'freelancer' })

    const { GET } = await import('@/app/api/routes-d/kyc-applications/sla-breaches/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('Forbidden: admin or compliance role required')
  })

  // ─────────────────────────────────────────────────────────────────────
  // Test Scenario 5: Empty state (no breached applications)
  // ─────────────────────────────────────────────────────────────────────

  it('returns empty list when no breached applications exist', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_admin' })
    userFindUnique.mockResolvedValue({ id: 'admin_1', role: 'admin' })
    kycApplicationFindMany.mockResolvedValue([])

    const { GET } = await import('@/app/api/routes-d/kyc-applications/sla-breaches/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.applications).toEqual([])
    expect(body.count).toBe(0)
    expect(body.slaWindowMs).toBeDefined()
  })

  // ─────────────────────────────────────────────────────────────────────
  // Test Scenario 1: Happy path - multiple breached applications sorted by overdue
  // ─────────────────────────────────────────────────────────────────────

  it('returns pending applications past SLA deadline sorted by severity (most overdue first)', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_admin' })
    userFindUnique.mockResolvedValue({ id: 'admin_1', role: 'admin' })

    // Create applications with different breach severities
    const now = new Date()
    const SLA_WINDOW_MS = 5 * 24 * 60 * 60 * 1000 // 5 days
    
    const breachedBy6Days = new Date(now.getTime() - (6 * 24 * 60 * 60 * 1000)) // 6 days ago (breached by ~1 day)
    const breachedBy10Days = new Date(now.getTime() - (10 * 24 * 60 * 60 * 1000)) // 10 days ago (breached by ~5 days)
    const breachedBy20Days = new Date(now.getTime() - (20 * 24 * 60 * 60 * 1000)) // 20 days ago (breached by ~15 days)

    kycApplicationFindMany.mockResolvedValue([
      {
        id: 'kyc_1',
        userId: 'user_1',
        status: 'pending',
        level: 'basic',
        fullName: 'Alice Smith',
        submittedAt: breachedBy6Days, // Least overdue
      },
      {
        id: 'kyc_2',
        userId: 'user_2',
        status: 'pending',
        level: 'basic',
        fullName: 'Bob Johnson',
        submittedAt: breachedBy10Days, // Moderately overdue
      },
      {
        id: 'kyc_3',
        userId: 'user_3',
        status: 'pending',
        level: 'basic',
        fullName: 'Charlie Brown',
        submittedAt: breachedBy20Days, // Most overdue
      },
    ])

    const { GET } = await import('@/app/api/routes-d/kyc-applications/sla-breaches/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.applications).toHaveLength(3)
    expect(body.count).toBe(3)

    // Verify sorted by overdue descending (most overdue first)
    expect(body.applications[0].id).toBe('kyc_3') // Most overdue
    expect(body.applications[0].overdueByMs).toBeGreaterThan(body.applications[1].overdueByMs)

    expect(body.applications[1].id).toBe('kyc_2') // Moderately overdue
    expect(body.applications[1].overdueByMs).toBeGreaterThan(body.applications[2].overdueByMs)

    expect(body.applications[2].id).toBe('kyc_1') // Least overdue
    expect(body.applications[2].overdueByMs).toBeGreaterThan(0) // Still positive (past deadline)
  })

  // ─────────────────────────────────────────────────────────────────────
  // Test Scenario 2: Exclusion test - pending but NOT breached (within SLA window)
  // ─────────────────────────────────────────────────────────────────────

  it('excludes pending applications that have NOT yet breached SLA', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_admin' })
    userFindUnique.mockResolvedValue({ id: 'admin_1', role: 'admin' })

    const now = new Date()
    
    // Application submitted 2 days ago (well within 5-day SLA)
    const withinSla = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000)
    
    // Application breached 1 day ago
    const breached = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000)

    kycApplicationFindMany.mockResolvedValue([
      {
        id: 'kyc_within',
        userId: 'user_within',
        status: 'pending',
        level: 'basic',
        fullName: 'Within SLA',
        submittedAt: withinSla,
      },
      {
        id: 'kyc_breached',
        userId: 'user_breached',
        status: 'pending',
        level: 'basic',
        fullName: 'Breached',
        submittedAt: breached,
      },
    ])

    const { GET } = await import('@/app/api/routes-d/kyc-applications/sla-breaches/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)

    const body = await res.json()
    // Only the breached application should be returned
    expect(body.applications).toHaveLength(1)
    expect(body.applications[0].id).toBe('kyc_breached')
  })

  // ─────────────────────────────────────────────────────────────────────
  // Test Scenario 3: Exclusion test - past deadline but NOT pending (reviewed/approved)
  // Note: The Prisma query filters by status='pending', so we simulate this by
  // having kycApplicationFindMany only return pending ones in the real query.
  // This test verifies the logic: if an app were returned with old timestamp
  // but status != pending, it would still be excluded (but that's handled by the WHERE clause).
  // We test the boundary: pending + at-or-past-deadline is included, but reviewed apps are not.
  // ─────────────────────────────────────────────────────────────────────

  it('excludes applications that have been reviewed even if past deadline by timestamp', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_admin' })
    userFindUnique.mockResolvedValue({ id: 'admin_1', role: 'admin' })

    const now = new Date()
    const breachedByTimestamp = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000) // 10 days ago

    // The Prisma query is mocked to only return pending applications (as per the WHERE clause in the route)
    // So this test verifies: if a reviewed app somehow came through (it shouldn't), we only include pending ones.
    // In practice, the WHERE clause filters this, so we just verify the route correctly queries by status.
    
    kycApplicationFindMany.mockResolvedValue([
      {
        id: 'kyc_pending',
        userId: 'user_pending',
        status: 'pending',
        level: 'basic',
        fullName: 'Pending App',
        submittedAt: breachedByTimestamp,
      },
      // This simulates what would happen if someone called the underlying query
      // But in reality, the WHERE clause { status: 'pending' } would filter this out
      // We're testing that our route only processes pending ones
    ])

    const { GET } = await import('@/app/api/routes-d/kyc-applications/sla-breaches/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.applications).toHaveLength(1)
    expect(body.applications[0].id).toBe('kyc_pending')

    // Verify the query was called with correct WHERE clause
    expect(kycApplicationFindMany).toHaveBeenCalledWith({
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

  // ─────────────────────────────────────────────────────────────────────
  // Test Scenario 4: Boundary - application exactly at SLA deadline
  // Using strict < comparison: zero overdue (at deadline) should be EXCLUDED
  // ─────────────────────────────────────────────────────────────────────

  it('excludes application exactly at SLA deadline (boundary: strict < not <=)', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_admin' })
    userFindUnique.mockResolvedValue({ id: 'admin_1', role: 'admin' })

    // Simulate application submitted exactly 5 days ago
    const SLA_WINDOW_MS = 5 * 24 * 60 * 60 * 1000
    const exactlyAtDeadline = new Date(Date.now() - SLA_WINDOW_MS)

    kycApplicationFindMany.mockResolvedValue([
      {
        id: 'kyc_boundary',
        userId: 'user_boundary',
        status: 'pending',
        level: 'basic',
        fullName: 'Boundary Application',
        submittedAt: exactlyAtDeadline,
      },
    ])

    const { GET } = await import('@/app/api/routes-d/kyc-applications/sla-breaches/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)

    const body = await res.json()
    // Application at exactly deadline should NOT be included (using strict <, not <=)
    expect(body.applications).toHaveLength(0)
    expect(body.count).toBe(0)
  })

  // ─────────────────────────────────────────────────────────────────────
  // Test Scenario 8: Database/query failure handled gracefully
  // ─────────────────────────────────────────────────────────────────────

  it('handles database error gracefully with 500 status', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_admin' })
    userFindUnique.mockResolvedValue({ id: 'admin_1', role: 'admin' })
    kycApplicationFindMany.mockRejectedValue(new Error('Database connection failed'))

    const { GET } = await import('@/app/api/routes-d/kyc-applications/sla-breaches/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(500)

    const body = await res.json()
    expect(body.error).toBe('Internal Server Error')
  })

  // ─────────────────────────────────────────────────────────────────────
  // Additional test: compliance role can access
  // ─────────────────────────────────────────────────────────────────────

  it('allows compliance role to access sla-breaches endpoint', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_compliance' })
    userFindUnique.mockResolvedValue({ id: 'compliance_1', role: 'compliance' })
    kycApplicationFindMany.mockResolvedValue([])

    const { GET } = await import('@/app/api/routes-d/kyc-applications/sla-breaches/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
  })

  // ─────────────────────────────────────────────────────────────────────
  // Additional test: handles applications with null submittedAt
  // ─────────────────────────────────────────────────────────────────────

  it('excludes applications with null submittedAt', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_admin' })
    userFindUnique.mockResolvedValue({ id: 'admin_1', role: 'admin' })

    const now = new Date()
    const breached = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000)

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
        submittedAt: breached,
      },
    ])

    const { GET } = await import('@/app/api/routes-d/kyc-applications/sla-breaches/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)

    const body = await res.json()
    // Only the one with a valid submittedAt that's breached should be included
    expect(body.applications).toHaveLength(1)
    expect(body.applications[0].id).toBe('kyc_with_submit')
  })

  // ─────────────────────────────────────────────────────────────────────
  // Additional test: verifies response structure and overdueByMs calculation
  // ─────────────────────────────────────────────────────────────────────

  it('returns correct response structure with overdueByMs calculation', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_admin' })
    userFindUnique.mockResolvedValue({ id: 'admin_1', role: 'admin' })

    const now = new Date()
    const SLA_WINDOW_MS = 5 * 24 * 60 * 60 * 1000
    
    // Application breached by exactly 1 day
    const breachedBy1Day = new Date(now.getTime() - (SLA_WINDOW_MS + 24 * 60 * 60 * 1000))

    kycApplicationFindMany.mockResolvedValue([
      {
        id: 'kyc_structure_test',
        userId: 'user_structure',
        status: 'pending',
        level: 'basic',
        fullName: 'Structure Test',
        submittedAt: breachedBy1Day,
      },
    ])

    const { GET } = await import('@/app/api/routes-d/kyc-applications/sla-breaches/route')
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
    expect(app).toHaveProperty('overdueByMs')

    // Verify types
    expect(typeof app.id).toBe('string')
    expect(typeof app.userId).toBe('string')
    expect(typeof app.overdueByMs).toBe('number')
    expect(app.overdueByMs).toBeGreaterThan(0) // Must be positive for breached apps

    // Verify overdueByMs is approximately 1 day (allowing for timing variations)
    const expectedOverdueMs = 24 * 60 * 60 * 1000
    expect(Math.abs(app.overdueByMs - expectedOverdueMs)).toBeLessThan(2000) // within 2 seconds
  })

  // ─────────────────────────────────────────────────────────────────────
  // Additional test: sorting order (descending by overdueByMs)
  // ─────────────────────────────────────────────────────────────────────

  it('sorts applications by overdueByMs in descending order (most overdue first)', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_compliance' })
    userFindUnique.mockResolvedValue({ id: 'compliance_1', role: 'compliance' })

    const now = new Date()
    const SLA_WINDOW_MS = 5 * 24 * 60 * 60 * 1000
    
    const breachedBy2Days = new Date(now.getTime() - (SLA_WINDOW_MS + 2 * 24 * 60 * 60 * 1000))
    const breachedBy5Days = new Date(now.getTime() - (SLA_WINDOW_MS + 5 * 24 * 60 * 60 * 1000))
    const breachedBy1Day = new Date(now.getTime() - (SLA_WINDOW_MS + 1 * 24 * 60 * 60 * 1000))

    // Return in non-sorted order to verify the route sorts them
    kycApplicationFindMany.mockResolvedValue([
      {
        id: 'kyc_2days',
        userId: 'user_2days',
        status: 'pending',
        level: 'basic',
        fullName: 'Breached 2 days',
        submittedAt: breachedBy2Days,
      },
      {
        id: 'kyc_1day',
        userId: 'user_1day',
        status: 'pending',
        level: 'basic',
        fullName: 'Breached 1 day',
        submittedAt: breachedBy1Day,
      },
      {
        id: 'kyc_5days',
        userId: 'user_5days',
        status: 'pending',
        level: 'basic',
        fullName: 'Breached 5 days',
        submittedAt: breachedBy5Days,
      },
    ])

    const { GET } = await import('@/app/api/routes-d/kyc-applications/sla-breaches/route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.applications).toHaveLength(3)

    // Verify descending order by overdueByMs
    expect(body.applications[0].id).toBe('kyc_5days')
    expect(body.applications[0].overdueByMs).toBeGreaterThan(body.applications[1].overdueByMs)

    expect(body.applications[1].id).toBe('kyc_2days')
    expect(body.applications[1].overdueByMs).toBeGreaterThan(body.applications[2].overdueByMs)

    expect(body.applications[2].id).toBe('kyc_1day')
  })
})
