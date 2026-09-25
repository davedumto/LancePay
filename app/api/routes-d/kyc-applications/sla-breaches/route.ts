import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { KYC_REVIEW_SLA_WINDOW_MS, KYC_STATUS_PENDING, getTimeRemainingMs } from '@/lib/kyc-config'

/**
 * GET /api/routes-d/kyc-applications/sla-breaches
 *
 * Reports pending KYC applications that have already breached the review SLA.
 * Only includes applications that are:
 *   1. Still pending (status === 'pending')
 *   2. Past their SLA deadline (submittedAt + SLA_WINDOW < now)
 *
 * Restricted to admin and compliance roles only.
 *
 * Response includes:
 * - Application ID, userId, status, level, fullName
 * - submittedAt (submission timestamp)
 * - slaDeadline (submittedAt + SLA_WINDOW)
 * - overdueByMs (milliseconds past the SLA deadline; always positive for breached apps)
 *
 * Sorted by overdueByMs descending: most severely overdue applications first.
 */
export async function GET(request: NextRequest) {
  try {
    // ─────────────────────────────────────────────────────────────────────
    // 1. AUTH: Extract and verify token
    // ─────────────────────────────────────────────────────────────────────
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    // ─────────────────────────────────────────────────────────────────────
    // 2. AUTH: Verify user exists and has admin/compliance role
    // ─────────────────────────────────────────────────────────────────────
    const actor = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true, role: true },
    })

    if (!actor) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Restrict to admin and compliance roles
    if (actor.role !== 'admin' && actor.role !== 'compliance') {
      return NextResponse.json(
        { error: 'Forbidden: admin or compliance role required' },
        { status: 403 }
      )
    }

    // ─────────────────────────────────────────────────────────────────────
    // 3. QUERY: Fetch pending KYC applications
    // ─────────────────────────────────────────────────────────────────────
    const applications = await prisma.kycApplication.findMany({
      where: { status: KYC_STATUS_PENDING },
      select: {
        id: true,
        userId: true,
        status: true,
        level: true,
        fullName: true,
        submittedAt: true,
      },
    })

    // ─────────────────────────────────────────────────────────────────────
    // 4. FILTER & COMPUTE: Identify breached applications and calculate overdue duration
    // ─────────────────────────────────────────────────────────────────────
    const now = Date.now()

    const breachedApplications = applications
      .filter((app) => {
        // Only process applications with a submittedAt timestamp
        if (!app.submittedAt) {
          return false
        }

        // Calculate time remaining until SLA breach
        // Negative values indicate the application has already breached the SLA
        const timeRemainingMs = getTimeRemainingMs(app.submittedAt, now)

        // Include only applications that are strictly past the deadline
        // (timeRemainingMs < 0, not <=, for consistency with #1485 boundary handling)
        return timeRemainingMs < 0
      })
      .map((app) => {
        // At this point, we know submittedAt is not null (filtered above)
        const submittedAt = app.submittedAt!
        const timeRemainingMs = getTimeRemainingMs(submittedAt, now)
        const slaDeadline = new Date(submittedAt.getTime() + KYC_REVIEW_SLA_WINDOW_MS)

        // overdueByMs is the absolute value of the negative timeRemainingMs
        const overdueByMs = Math.abs(timeRemainingMs)

        return {
          id: app.id,
          userId: app.userId,
          status: app.status,
          level: app.level,
          fullName: app.fullName,
          submittedAt,
          slaDeadline,
          overdueByMs,
        }
      })
      // Sort by overdueByMs descending (most severely overdue first)
      .sort((a, b) => b.overdueByMs - a.overdueByMs)

    // ─────────────────────────────────────────────────────────────────────
    // 5. RESPONSE: Return formatted list of breached applications
    // ─────────────────────────────────────────────────────────────────────
    return NextResponse.json({
      applications: breachedApplications,
      count: breachedApplications.length,
      slaWindowMs: KYC_REVIEW_SLA_WINDOW_MS,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/kyc-applications/sla-breaches error')
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
