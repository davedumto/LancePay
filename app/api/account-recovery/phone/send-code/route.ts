import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { buildRateLimitResponse, RouteRateLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'

export const phoneRecoverySendLimiter = new RouteRateLimiter({
  id: 'phone-recovery-send',
  maxRequests: 3,
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

    const payload = (body ?? {}) as { phone?: unknown }
    const phone = typeof payload.phone === 'string' ? payload.phone.trim() : user.recoveryPhone
    if (!phone) {
      return NextResponse.json({ error: 'Phone number is required' }, { status: 400 })
    }

    const rateLimitKey = `${user.id}:${phone}`
    const rateLimitResult = phoneRecoverySendLimiter.check(rateLimitKey)
    if (!rateLimitResult.allowed) {
      return buildRateLimitResponse(rateLimitResult)
    }

    // Invalidate any prior unverified codes for the same user
    await prisma.recoveryPhoneVerification.deleteMany({
      where: {
        userId: user.id,
        verified: false,
      },
    })

    // Generate short numeric 6-digit code and bounded expiresAt (10 mins)
    const code = Math.floor(100000 + Math.random() * 900000).toString()
    const expiresAt = new Date(Date.now() + 10 * 60_000)

    const verification = await prisma.recoveryPhoneVerification.create({
      data: {
        userId: user.id,
        phone,
        code,
        expiresAt,
        verified: false,
      },
    })

    return NextResponse.json(
      {
        success: true,
        message: 'Verification code sent',
        expiresAt: verification.expiresAt.toISOString(),
      },
      { status: 200 }
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/account-recovery/phone/send-code error')
    return NextResponse.json({ error: 'Failed to send recovery verification code' }, { status: 500 })
  }
}
