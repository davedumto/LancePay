import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// ── GET /api/routes-d/kyc/status — fetch KYC application status ──
//
// Returns the current KYC application status for the authenticated user.
// If no application exists, returns a "not_submitted" status.

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const application = await prisma.kycApplication.findUnique({
      where: { userId: user.id },
      select: {
        id: true,
        status: true,
        level: true,
        fullName: true,
        submittedAt: true,
        reviewedAt: true,
        rejectionReason: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    if (!application) {
      return NextResponse.json({
        status: 'not_submitted',
        application: null,
      })
    }

    return NextResponse.json({
      status: application.status,
      application,
    })
  } catch (error) {
    logger.error({ err: error }, 'KYC status error')
    return NextResponse.json({ error: 'Failed to fetch KYC status' }, { status: 500 })
  }
}
