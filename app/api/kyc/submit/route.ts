import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { KYC_STATUS_PENDING } from '@/lib/kyc-config'

export const SUPPORTED_KYC_LEVELS = ['basic', 'intermediate', 'enhanced'] as const
export type KycLevel = (typeof SUPPORTED_KYC_LEVELS)[number]

const APPLICATION_SELECT = {
  id: true,
  userId: true,
  status: true,
  level: true,
  fullName: true,
  dateOfBirth: true,
  countryCode: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  region: true,
  postalCode: true,
  rejectionReason: true,
  submittedAt: true,
  reviewedAt: true,
  createdAt: true,
  updatedAt: true,
} as const

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as any).code === 'P2002'
}

function nonEmptyString(val: unknown): string | null {
  if (typeof val !== 'string') return null
  const trimmed = val.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * POST /api/kyc/submit
 * Submit an initial or re-submitted KYC application for the authenticated user:
 * - Enforces the unique `userId` constraint on `KycApplication` by upserting when a
 *   prior `'rejected'` application exists, and returning 409 Conflict if an application
 *   is already `'pending'` or `'approved'`.
 * - Validates required fields for the declared KYC `level` (`basic` requires `fullName`,
 *   `dateOfBirth`, `countryCode`; `intermediate` / `enhanced` additionally require
 *   `addressLine1`, `city`, and `postalCode`).
 * - Sets `status: 'pending'` and `submittedAt: new Date()` on submission.
 */
export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const body = (rawBody ?? {}) as Record<string, unknown>
    const rawLevel = nonEmptyString(body.level)?.toLowerCase() ?? 'basic'

    if (!(SUPPORTED_KYC_LEVELS as readonly string[]).includes(rawLevel)) {
      return NextResponse.json(
        {
          error: `level must be one of: ${SUPPORTED_KYC_LEVELS.join(', ')}`,
          code: 'INVALID_KYC_LEVEL',
        },
        { status: 400 },
      )
    }
    const level = rawLevel as KycLevel

    const fullName = nonEmptyString(body.fullName)
    if (!fullName) {
      return NextResponse.json({ error: 'fullName is required' }, { status: 400 })
    }

    const rawDob = nonEmptyString(body.dateOfBirth)
    if (!rawDob) {
      return NextResponse.json({ error: 'dateOfBirth is required' }, { status: 400 })
    }
    const dateOfBirth = new Date(rawDob)
    if (Number.isNaN(dateOfBirth.getTime())) {
      return NextResponse.json(
        { error: 'dateOfBirth must be a valid ISO date' },
        { status: 400 },
      )
    }

    const countryCode = nonEmptyString(body.countryCode)?.toUpperCase() ?? null
    if (!countryCode || !/^[A-Z]{2}$/.test(countryCode)) {
      return NextResponse.json(
        { error: 'countryCode is required and must be a 2-letter ISO country code' },
        { status: 400 },
      )
    }

    const addressLine1 = nonEmptyString(body.addressLine1)
    const addressLine2 = nonEmptyString(body.addressLine2)
    const city = nonEmptyString(body.city)
    const region = nonEmptyString(body.region)
    const postalCode = nonEmptyString(body.postalCode)

    if (level === 'intermediate' || level === 'enhanced') {
      if (!addressLine1 || !city || !postalCode) {
        return NextResponse.json(
          {
            error: `addressLine1, city, and postalCode are required for "${level}" KYC level`,
            code: 'MISSING_ENHANCED_KYC_FIELDS',
          },
          { status: 400 },
        )
      }
    }

    const existing = await prisma.kycApplication.findUnique({
      where: { userId: user.id },
      select: { id: true, status: true },
    })

    if (existing && (existing.status === 'pending' || existing.status === 'approved')) {
      return NextResponse.json(
        {
          error: `A KYC application is already ${existing.status} for this user`,
          code: 'KYC_APPLICATION_ALREADY_EXISTS',
          status: existing.status,
        },
        { status: 409 },
      )
    }

    const now = new Date()
    const payloadData = {
      status: KYC_STATUS_PENDING,
      level,
      fullName,
      dateOfBirth,
      countryCode,
      addressLine1,
      addressLine2,
      city,
      region,
      postalCode,
      rejectionReason: null,
      submittedAt: now,
      reviewedAt: null,
    }

    try {
      const application = await prisma.kycApplication.upsert({
        where: { userId: user.id },
        create: {
          userId: user.id,
          ...payloadData,
        },
        update: payloadData,
        select: APPLICATION_SELECT,
      })

      return NextResponse.json(
        {
          application,
          resubmitted: Boolean(existing && existing.status === 'rejected'),
        },
        { status: 201 },
      )
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return NextResponse.json(
          {
            error: 'A KYC application already exists for this user',
            code: 'KYC_APPLICATION_ALREADY_EXISTS',
          },
          { status: 409 },
        )
      }
      throw err
    }
  } catch (error) {
    logger.error({ err: error }, 'POST /api/kyc/submit error')
    return NextResponse.json(
      { error: 'Failed to submit KYC application' },
      { status: 500 },
    )
  }
}
