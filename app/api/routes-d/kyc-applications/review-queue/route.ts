import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { KYC_REVIEW_SLA_WINDOW_MS, KYC_STATUS_PENDING, getTimeRemainingMs } from '@/lib/kyc-config'

/**
 * GET /api/routes-d/kyc-applications/review-queue
 *
 * Lists pending KYC applications ordered by SLA urgency (most urgent first).
 * Restricted to admin and compliance roles only.
 *
 * Response includes:
 * - Application ID, userId, status, level, fullName
 * - submittedAt (submission timestamp)
 * - slaDeadline (submittedAt + SLA_WINDOW)
 * - timeRemainingMs (milliseconds until SLA breach; negative if breached)
 * - breached (boolean flag for convenience)
 *
 * Sorted by timeRemainingMs ascending: most urgent/breached applications first.
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
    // 3. QUERY: Fetch all pending KYC applications
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
    // 4. COMPUTE: Calculate SLA metrics and sort by urgency
    // ─────────────────────────────────────────────────────────────────────
    const now = Date.now()

    const applicationsWithSla = applications
      .map((app) => {
        // Only compute SLA metrics if submittedAt is set
        if (!app.submittedAt) {
          return {
            id: app.id,
            userId: app.userId,
            status: app.status,
            level: app.level,
            fullName: app.fullName,
            submittedAt: null,
            slaDeadline: null,
            timeRemainingMs: null,
            breached: false,
          }
        }

        const timeRemainingMs = getTimeRemainingMs(app.submittedAt, now)
        const slaDeadline = new Date(app.submittedAt.getTime() + KYC_REVIEW_SLA_WINDOW_MS)

        return {
          id: app.id,
          userId: app.userId,
          status: app.status,
          level: app.level,
          fullName: app.fullName,
          submittedAt: app.submittedAt,
          slaDeadline,
          timeRemainingMs,
          breached: timeRemainingMs < 0,
        }
      })
      // Sort by timeRemainingMs ascending (most urgent/breached first)
      // Handle null values by placing them at the end
      .sort((a, b) => {
        if (a.timeRemainingMs === null && b.timeRemainingMs === null) return 0
        if (a.timeRemainingMs === null) return 1
        if (b.timeRemainingMs === null) return -1
        return a.timeRemainingMs - b.timeRemainingMs
      })

    // ─────────────────────────────────────────────────────────────────────
    // 5. RESPONSE: Return formatted list
    // ─────────────────────────────────────────────────────────────────────
    return NextResponse.json({
      applications: applicationsWithSla,
      count: applicationsWithSla.length,
      slaWindowMs: KYC_REVIEW_SLA_WINDOW_MS,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/kyc-applications/review-queue error')
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
