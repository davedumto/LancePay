import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// ── POST /api/routes-d/kyc/submit — submit (or re-submit) a KYC application ──
//
// One application per user (enforced by the @@unique([userId])) in the schema.
// Calling submit while a Pending or Approved application already exists is
// rejected so reviewers don't race against the user.

const VALID_LEVELS = ['basic', 'enhanced'] as const
const COUNTRY_CODE_REGEX = /^[A-Z]{2}$/

type Body = {
  level?: string
  fullName?: string
  dateOfBirth?: string
  countryCode?: string
  addressLine1?: string
  addressLine2?: string
  city?: string
  region?: string
  postalCode?: string
}

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const body = (await request.json().catch(() => null)) as Body | null
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

    const { level, fullName, dateOfBirth, countryCode, addressLine1, addressLine2, city, region, postalCode } = body

    if (!fullName || typeof fullName !== 'string' || fullName.trim().length < 2) {
      return NextResponse.json({ error: 'fullName is required (≥ 2 chars)' }, { status: 400 })
    }
    if (!countryCode || !COUNTRY_CODE_REGEX.test(countryCode)) {
      return NextResponse.json({ error: 'countryCode must be a 2-letter ISO 3166 code' }, { status: 400 })
    }
    if (!dateOfBirth || typeof dateOfBirth !== 'string') {
      return NextResponse.json({ error: 'dateOfBirth (ISO 8601) is required' }, { status: 400 })
    }
    const dob = new Date(dateOfBirth)
    if (Number.isNaN(dob.getTime())) {
      return NextResponse.json({ error: 'dateOfBirth must be a valid ISO 8601 date' }, { status: 400 })
    }
    if (dob > new Date()) {
      return NextResponse.json({ error: 'dateOfBirth cannot be in the future' }, { status: 400 })
    }
    const requestedLevel = level ?? 'basic'
    if (!VALID_LEVELS.includes(requestedLevel as typeof VALID_LEVELS[number])) {
      return NextResponse.json(
        { error: `level must be one of: ${VALID_LEVELS.join(', ')}` },
        { status: 400 },
      )
    }

    // Block resubmits while a pending/approved application is open.
    const existing = await prisma.kycApplication.findUnique({ where: { userId: user.id } })
    if (existing && (existing.status === 'pending' || existing.status === 'approved')) {
      return NextResponse.json(
        { error: `KYC application already ${existing.status}` },
        { status: 409 },
      )
    }

    const application = await prisma.kycApplication.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        status: 'pending',
        level: requestedLevel,
        fullName: fullName.trim(),
        dateOfBirth: dob,
        countryCode,
        addressLine1: addressLine1 ?? null,
        addressLine2: addressLine2 ?? null,
        city: city ?? null,
        region: region ?? null,
        postalCode: postalCode ?? null,
        submittedAt: new Date(),
      },
      update: {
        status: 'pending',
        level: requestedLevel,
        fullName: fullName.trim(),
        dateOfBirth: dob,
        countryCode,
        addressLine1: addressLine1 ?? null,
        addressLine2: addressLine2 ?? null,
        city: city ?? null,
        region: region ?? null,
        postalCode: postalCode ?? null,
        rejectionReason: null,
        submittedAt: new Date(),
        reviewedAt: null,
      },
    })

    return NextResponse.json({ application }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'KYC submit error')
    return NextResponse.json({ error: 'Failed to submit KYC application' }, { status: 500 })
  }
}
