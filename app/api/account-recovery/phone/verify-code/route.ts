import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { buildRateLimitResponse, RouteRateLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'

export const phoneRecoveryVerifyLimiter = new RouteRateLimiter({
  id: 'phone-recovery-verify',
  maxRequests: 5,
  windowMs: 15 * 60_000,
})

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const rawCode = (body as { code?: unknown } | null)?.code
    if (typeof rawCode !== 'string' || rawCode.trim() === '') {
      return NextResponse.json({ error: 'Verification code is required' }, { status: 400 })
    }

    const verification = await prisma.recoveryPhoneVerification.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    })

    if (!verification) {
      return NextResponse.json({ error: 'Verification code not found' }, { status: 404 })
    }
    if (verification.expiresAt <= new Date()) {
      return NextResponse.json({ error: 'Verification code has expired' }, { status: 410 })
    }
    if (verification.verified) {
      return NextResponse.json({ error: 'Verification code has already been used' }, { status: 409 })
    }

    const rateLimitResult = phoneRecoveryVerifyLimiter.check(verification.id)
    if (!rateLimitResult.allowed) return buildRateLimitResponse(rateLimitResult)

    if (rawCode.trim() !== verification.code) {
      return NextResponse.json({ error: 'Invalid verification code' }, { status: 400 })
    }

    const consumption = await prisma.$transaction(async (transaction) => {
      const result = await transaction.recoveryPhoneVerification.updateMany({
        where: {
          id: verification.id,
          verified: false,
          expiresAt: { gt: new Date() },
        },
        data: { verified: true },
      })
      if (result.count === 0) {
        const current = await transaction.recoveryPhoneVerification.findUnique({
          where: { id: verification.id },
          select: { verified: true, expiresAt: true },
        })
        return current && current.expiresAt <= new Date() ? 'expired' : 'used'
      }

      await transaction.user.update({
        where: { id: user.id },
        data: { recoveryPhone: verification.phone, recoveryPhoneVerified: true },
      })
      return 'verified'
    })

    if (consumption === 'expired') {
      return NextResponse.json({ error: 'Verification code has expired' }, { status: 410 })
    }
    if (consumption === 'used') {
      return NextResponse.json({ error: 'Verification code has already been used' }, { status: 409 })
    }

    return NextResponse.json({ message: 'Recovery phone verified successfully' })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/account-recovery/phone/verify-code error')
    return NextResponse.json({ error: 'Failed to verify recovery phone' }, { status: 500 })
  }
}