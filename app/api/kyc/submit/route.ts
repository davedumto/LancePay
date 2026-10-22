import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const {
      fullName,
      dateOfBirth,
      countryCode,
      addressLine1,
      addressLine2,
      city,
      region,
      postalCode,
      level = 'basic',
    } = (body ?? {}) as {
      fullName?: string
      dateOfBirth?: string
      countryCode?: string
      addressLine1?: string
      addressLine2?: string
      city?: string
      region?: string
      postalCode?: string
      level?: string
    }

    // Validate required fields for basic level
    if (!fullName || typeof fullName !== 'string' || !fullName.trim()) {
      return NextResponse.json({ error: 'fullName is required' }, { status: 400 })
    }
    if (!dateOfBirth || typeof dateOfBirth !== 'string' || !dateOfBirth.trim()) {
      return NextResponse.json({ error: 'dateOfBirth is required' }, { status: 400 })
    }
    const dob = new Date(dateOfBirth)
    if (Number.isNaN(dob.getTime())) {
      return NextResponse.json({ error: 'dateOfBirth must be a valid date' }, { status: 400 })
    }
    if (!countryCode || typeof countryCode !== 'string' || countryCode.trim().length !== 2) {
      return NextResponse.json({ error: 'countryCode must be a 2-letter ISO code' }, { status: 400 })
    }
    if (!addressLine1 || typeof addressLine1 !== 'string' || !addressLine1.trim()) {
      return NextResponse.json({ error: 'addressLine1 is required' }, { status: 400 })
    }
    if (!city || typeof city !== 'string' || !city.trim()) {
      return NextResponse.json({ error: 'city is required' }, { status: 400 })
    }
    if (!postalCode || typeof postalCode !== 'string' || !postalCode.trim()) {
      return NextResponse.json({ error: 'postalCode is required' }, { status: 400 })
    }

    // Check existing application
    const existing = await prisma.kycApplication.findUnique({
      where: { userId: user.id },
    })

    if (existing) {
      if (existing.status === 'approved') {
        return NextResponse.json({ error: 'KYC application already approved' }, { status: 409 })
      }
      if (existing.status === 'pending') {
        return NextResponse.json({ error: 'KYC application is already under review' }, { status: 409 })
      }
    }

    const application = await prisma.kycApplication.upsert({
      where: { userId: user.id },
      update: {
        fullName: fullName.trim(),
        dateOfBirth: dob,
        countryCode: countryCode.trim().toUpperCase(),
        addressLine1: addressLine1.trim(),
        addressLine2: addressLine2?.trim() || null,
        city: city.trim(),
        region: region?.trim() || null,
        postalCode: postalCode.trim(),
        level,
        status: 'pending',
        rejectionReason: null,
        submittedAt: new Date(),
      },
      create: {
        userId: user.id,
        fullName: fullName.trim(),
        dateOfBirth: dob,
        countryCode: countryCode.trim().toUpperCase(),
        addressLine1: addressLine1.trim(),
        addressLine2: addressLine2?.trim() || null,
        city: city.trim(),
        region: region?.trim() || null,
        postalCode: postalCode.trim(),
        level,
        status: 'pending',
        submittedAt: new Date(),
      },
    })

    return NextResponse.json({ application }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/kyc/submit error')
    return NextResponse.json({ error: 'Failed to submit KYC application' }, { status: 500 })
  }
}
