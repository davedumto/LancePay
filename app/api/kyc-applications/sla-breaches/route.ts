import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { KYC_REVIEW_SLA_WINDOW_MS } from '@/lib/kyc-config'

const ALLOWED_ROLES = new Set(['admin', 'compliance'])

// GET /api/kyc-applications/sla-breaches — report pending KYC applications that
// have already breached the review SLA deadline. Returns each application with how
// far past the deadline it is. Admin and compliance roles only.

export async function GET(request: NextRequest) {
  try {
    const token = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(token)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    if (!ALLOWED_ROLES.has(user.role)) {
      return NextResponse.json(
        { error: 'Forbidden: admin or compliance role required' },
        { status: 403 },
      )
    }

    // Fetch all pending applications
    const applications = await prisma.kycApplication.findMany({
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

    const now = Date.now()

    // Filter to only breached applications and calculate how far overdue
    const breached = applications
      .filter((app) => {
        if (!app.submittedAt) return false
        const deadline = app.submittedAt.getTime() + KYC_REVIEW_SLA_WINDOW_MS
        return now > deadline
      })
      .map((app) => {
        const deadline = app.submittedAt!.getTime() + KYC_REVIEW_SLA_WINDOW_MS
        const overdueByMs = now - deadline
        return {
          id: app.id,
          userId: app.userId,
          status: app.status,
          level: app.level,
          fullName: app.fullName,
          submittedAt: app.submittedAt,
          slaDeadline: new Date(deadline),
          overdueByMs,
        }
      })
      // Sort by overdue descending (most overdue first)
      .sort((a, b) => b.overdueByMs - a.overdueByMs)

    return NextResponse.json({
      applications: breached,
      count: breached.length,
      slaWindowMs: KYC_REVIEW_SLA_WINDOW_MS,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/kyc-applications/sla-breaches error')
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
