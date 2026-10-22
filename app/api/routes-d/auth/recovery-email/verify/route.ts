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

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const body = await request.json()
    const { code } = body

    if (!code || typeof code !== 'string' || code.trim() === '') {
      return NextResponse.json({ error: 'Verification code is required' }, { status: 400 })
    }

    const pending = await (prisma as any).recoveryEmailVerification.findFirst({
      where: {
        userId: user.id,
        code: code.trim(),
        expiresAt: { gt: new Date() },
        verified: false,
      },
    })

    if (!pending) {
      return NextResponse.json({ error: 'Invalid or expired verification code' }, { status: 400 })
    }

    await prisma.$transaction([
      (prisma as any).recoveryEmailVerification.update({
        where: { id: pending.id },
        data: { verified: true },
      }),
      (prisma as any).user.update({
        where: { id: user.id },
        data: { recoveryEmail: pending.email, recoveryEmailVerified: true },
      }),
    ])

    return NextResponse.json({ message: 'Recovery email verified successfully' })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-d/auth/recovery-email/verify error')
    return NextResponse.json({ error: 'Failed to verify recovery email' }, { status: 500 })
  }
}
