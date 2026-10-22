import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

/**
 * GET /api/kyc/status
 * Check the authenticated user's KYC application status.
 * 
 * Response includes:
 * - status: 'pending', 'approved', 'rejected', or 'no-application'
 * - level: KYC level (e.g., 'basic', 'enhanced')
 * - rejectionReason: included only when status is 'rejected'
 */
export async function GET(request: NextRequest) {
  try {
    // Extract and verify auth token
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Look up user by Privy ID
    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })
    
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Fetch user's KYC application
    const kycApplication = await prisma.kycApplication.findUnique({
      where: { userId: user.id },
      select: {
        status: true,
        level: true,
        rejectionReason: true,
      },
    })

    // No application yet - return distinct no-application state
    if (!kycApplication) {
      return NextResponse.json(
        {
          status: 'no-application',
          level: null,
        },
        { status: 200 }
      )
    }

    // Build response
    const response: any = {
      status: kycApplication.status,
      level: kycApplication.level,
    }

    // Include rejection reason only when status is rejected
    if (kycApplication.status === 'rejected' && kycApplication.rejectionReason) {
      response.rejectionReason = kycApplication.rejectionReason
    }

    return NextResponse.json(response, { status: 200 })
  } catch (error) {
    console.error('GET /api/kyc/status error:', error)
    return NextResponse.json(
      { error: 'Failed to retrieve KYC status' },
      { status: 500 }
    )
  }
}
