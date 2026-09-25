import { NextRequest, NextResponse } from 'next/server'
import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'

/**
 * Type definitions for verification status response
 */
type VerificationStatus = 'never-attempted' | 'pending' | 'verified' | 'failed'

interface VerificationStatusResponse {
  status: VerificationStatus
  lastCheckedAt?: string
  customDomain?: string
  message: string
}

/**
 * Maps the stored verification status to the API response enum.
 * Converts database storage format to user-facing status.
 *
 * Storage formats:
 * - "unverified": Initial state (never-attempted)
 * - "pending": Verification initiated but token not yet found in DNS
 * - "verified": Token found in DNS, domain verified
 *
 * Response format must be one of exactly four states:
 * - "never-attempted": No verification has ever been initiated
 * - "pending": Verification in progress, waiting for DNS record
 * - "verified": Domain successfully verified
 * - "failed": Verification failed (terminal state) — currently not distinguished from pending in schema
 */
function mapStorageStatusToApiStatus(
  storedStatus: string | null,
  verificationToken: string | null,
): VerificationStatus {
  // Never-attempted: no status set (null) or explicit "unverified" with no token
  if (storedStatus === null || storedStatus === 'unverified') {
    return 'never-attempted'
  }

  // All other cases map directly
  if (storedStatus === 'pending') {
    return 'pending'
  }

  if (storedStatus === 'verified') {
    return 'verified'
  }

  // Defensive: fallback to never-attempted if unknown status
  logger.warn(
    { storedStatus },
    'Received unknown verification status in database, treating as never-attempted',
  )
  return 'never-attempted'
}

async function authenticatedUser(request: NextRequest) {
  const token = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return null
  const claims = await verifyAuthToken(token)
  if (!claims) return null
  return prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true, role: true },
  })
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    // Authenticate the requesting user
    const currentUser = await authenticatedUser(request)
    if (!currentUser) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Authentication required' },
        { status: 401 },
      )
    }

    // Extract and validate the userId route parameter
    const { userId } = await params
    if (!userId || typeof userId !== 'string' || userId.trim() === '') {
      return NextResponse.json(
        { error: 'Bad request', message: 'Invalid userId parameter' },
        { status: 400 },
      )
    }

    // Authorization: user must be either:
    // 1. Requesting their own status (userId matches their id), OR
    // 2. An admin user
    const isOwner = currentUser.id === userId
    const isAdmin = currentUser.role === 'admin'

    if (!isOwner && !isAdmin) {
      return NextResponse.json(
        {
          error: 'Forbidden',
          message: 'You can only view your own verification status unless you are an admin',
        },
        { status: 403 },
      )
    }

    // Fetch the target user's branding settings
    const brandingSettings = await prisma.brandingSettings.findUnique({
      where: { userId },
      select: {
        verificationStatus: true,
        verifiedAt: true,
        customDomain: true,
        verificationToken: true,
      },
    })

    // Handle missing branding settings: treat as never-attempted
    // (no previous verification attempt has been made)
    if (!brandingSettings) {
      const response: VerificationStatusResponse = {
        status: 'never-attempted',
        message: 'No verification attempt has been made yet',
      }
      return NextResponse.json(response, { status: 200 })
    }

    // Map stored status to API response format
    const apiStatus = mapStorageStatusToApiStatus(
      brandingSettings.verificationStatus,
      brandingSettings.verificationToken || null,
    )

    // Build response
    const response: VerificationStatusResponse = {
      status: apiStatus,
      message: `Domain verification status: ${apiStatus}`,
    }

    // Include custom domain if it exists
    if (brandingSettings.customDomain) {
      response.customDomain = brandingSettings.customDomain
    }

    // Include last-checked timestamp ONLY if verification has been attempted
    // (i.e., not for never-attempted state)
    if (apiStatus !== 'never-attempted' && brandingSettings.verifiedAt) {
      response.lastCheckedAt = brandingSettings.verifiedAt.toISOString()
    }

    logger.debug(
      {
        requestingUserId: currentUser.id,
        targetUserId: userId,
        status: apiStatus,
        isOwner,
        isAdmin,
      },
      'Verification status retrieved',
    )

    return NextResponse.json(response, { status: 200 })
  } catch (error) {
    logger.error(
      { err: error },
      'GET /api/branding-settings/[userId]/verification-status error',
    )
    return NextResponse.json(
      { error: 'Internal server error', message: 'Failed to retrieve verification status' },
      { status: 500 },
    )
  }
}
