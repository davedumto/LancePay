import { NextRequest, NextResponse } from 'next/server'
import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { z } from 'zod'
import { isAdmin } from '@/lib/authorization'

/**
 * Document expiry windows (in days) by document type.
 * These define how long each document type is valid for after upload.
 */
const DOCUMENT_EXPIRY_WINDOWS: Record<string, number> = {
  passport: 365, // 1 year
  national_id: 365, // 1 year
  utility_bill: 90, // 90 days
  proof_of_address: 90, // 90 days
  driver_license: 365, // 1 year
  visa: 365, // 1 year
}

/**
 * Default lookahead window in days when not specified.
 * This is 30 days, giving compliance staff a month to prompt renewal.
 */
const DEFAULT_LOOKAHEAD_DAYS = 30

/**
 * Calculates the expiry date for a document based on its type and creation date.
 */
function calculateDocumentExpiry(documentType: string, createdAt: Date): Date {
  const windowDays = DOCUMENT_EXPIRY_WINDOWS[documentType] || 90 // default to 90 if unknown
  const expiryDate = new Date(createdAt)
  expiryDate.setDate(expiryDate.getDate() + windowDays)
  return expiryDate
}

/**
 * GET /api/routes-d/kyc/expiring-documents
 *
 * Sweeps for KYC applications with documents nearing expiry.
 * Returns applications whose document expiry falls within the lookahead window.
 * Excludes applications in rejected terminal state.
 *
 * Query Parameters:
 * - days (optional): Lookahead window in days (positive integer, default: 30)
 *
 * Response:
 * - applications: Array of applications with expiring documents
 *   - id: Application ID
 *   - userId: User ID
 *   - status: Application status
 *   - level: KYC level (basic, advanced, etc.)
 *   - fullName: Applicant full name
 *   - createdAt: Application creation timestamp
 *   - documents: Array of documents nearing expiry
 *     - id: Document ID
 *     - documentType: Type of document
 *     - expiresAt: Document expiry timestamp
 *     - daysRemaining: Days until expiry
 *   - user: User details
 *     - id: User ID
 *     - email: User email
 *     - name: User name
 */
export async function GET(request: NextRequest) {
  try {
    // Extract and verify auth token
    const authHeader = request.headers.get('authorization')
    const token = authHeader?.replace('Bearer ', '')

    if (!token) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const claims = await verifyAuthToken(token)
    if (!claims) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Find user by Privy ID
    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true, role: true },
    })

    if (!user) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      )
    }

    // Check authorization: admin or compliance role only
    if (!isAdmin(user) && user.role !== 'compliance') {
      return NextResponse.json(
        { error: 'Forbidden: admin or compliance access required' },
        { status: 403 }
      )
    }

    // Parse and validate query parameters
    const queryParseResult = z.object({
      days: z.coerce.number().int().positive().optional(),
    }).safeParse({
      days: request.nextUrl.searchParams.get('days'),
    })

    if (!queryParseResult.success) {
      return NextResponse.json(
        {
          error: 'Invalid request parameters',
          details: queryParseResult.error.flatten().fieldErrors,
        },
        { status: 400 }
      )
    }

    const lookaheadDays = queryParseResult.data.days ?? DEFAULT_LOOKAHEAD_DAYS

    // Calculate the expiry window: now to now + lookahead days
    const now = new Date()
    const windowEnd = new Date(now)
    windowEnd.setDate(windowEnd.getDate() + lookaheadDays)

    // Fetch all KYC applications that are not rejected
    const applications = await prisma.kycApplication.findMany({
      where: {
        NOT: {
          status: 'rejected',
        },
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    // Fetch all KYC documents and filter for expiring ones
    const allDocuments = await prisma.kycDocument.findMany({
      select: {
        id: true,
        userId: true,
        documentType: true,
        createdAt: true,
      },
    })

    // Build a map of user ID to their documents with expiry info
    const userDocumentsMap = new Map<
      string,
      Array<{
        id: string
        documentType: string
        expiresAt: Date
        daysRemaining: number
      }>
    >()

    for (const doc of allDocuments) {
      const expiresAt = calculateDocumentExpiry(doc.documentType, doc.createdAt)
      const daysRemaining = Math.ceil(
        (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
      )

      // Include documents that:
      // 1. Are within the lookahead window (expiring soon but not yet expired)
      // 2. Have not already expired (daysRemaining >= 0)
      if (expiresAt >= now && expiresAt <= windowEnd) {
        if (!userDocumentsMap.has(doc.userId)) {
          userDocumentsMap.set(doc.userId, [])
        }
        userDocumentsMap.get(doc.userId)!.push({
          id: doc.id,
          documentType: doc.documentType,
          expiresAt,
          daysRemaining,
        })
      }
    }

    // Filter applications to only those with expiring documents
    const result = applications
      .filter((app) => userDocumentsMap.has(app.userId))
      .map((app) => ({
        id: app.id,
        userId: app.userId,
        status: app.status,
        level: app.level,
        fullName: app.fullName,
        createdAt: app.createdAt,
        documents: userDocumentsMap.get(app.userId) || [],
        user: app.user,
      }))

    return NextResponse.json({
      applications: result,
      count: result.length,
      lookaheadDays,
      generatedAt: now,
    })
  } catch (error) {
    console.error('Error in GET /api/routes-d/kyc/expiring-documents:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
