import { createHash } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const INVALID_TOKEN_ERROR = 'Invalid or expired verification token'

function hashVerificationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

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
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 401 })

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { token } = (body ?? {}) as { token?: unknown }
    if (typeof token !== 'string' || token.trim() === '') {
      return NextResponse.json({ error: 'token must be a non-empty string' }, { status: 400 })
    }

    const recoveryEmail = await prisma.recoveryEmail.findUnique({
      where: { userId: user.id },
      select: {
        id: true,
        email: true,
        tokenHash: true,
        tokenExpiresAt: true,
        verifiedAt: true,
      },
    })
    if (!recoveryEmail) {
      return NextResponse.json(
        { error: 'No recovery email pending verification' },
        { status: 404 },
      )
    }

    if (recoveryEmail.verifiedAt) {
      return NextResponse.json(
        { error: 'Recovery email is already verified' },
        { status: 400 },
      )
    }

    if (
      !recoveryEmail.tokenHash ||
      recoveryEmail.tokenHash !== hashVerificationToken(token.trim()) ||
      !recoveryEmail.tokenExpiresAt ||
      recoveryEmail.tokenExpiresAt.getTime() < Date.now()
    ) {
      return NextResponse.json({ error: INVALID_TOKEN_ERROR }, { status: 400 })
    }

    const updated = await prisma.recoveryEmail.update({
      where: { id: recoveryEmail.id },
      data: {
        verifiedAt: new Date(),
        tokenHash: null,
        tokenExpiresAt: null,
      },
      select: { email: true, verifiedAt: true },
    })

    return NextResponse.json({ recoveryEmail: updated })
  } catch (error) {
    logger.error({ err: error }, 'POST /auth/recovery-email/verify error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
