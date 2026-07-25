import { createHash, randomBytes, scryptSync } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const MIN_PASSWORD_LENGTH = 8
const MAX_PASSWORD_LENGTH = 128
const INVALID_TOKEN_ERROR = 'Invalid or expired reset token'

function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const derived = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${derived}`
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

    const { token, newPassword } = (body ?? {}) as { token?: unknown; newPassword?: unknown }

    if (typeof token !== 'string' || token.trim() === '') {
      return NextResponse.json({ error: 'token must be a non-empty string' }, { status: 400 })
    }

    if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
      return NextResponse.json(
        { error: `newPassword must be a string of at least ${MIN_PASSWORD_LENGTH} characters` },
        { status: 400 },
      )
    }
    if (newPassword.length > MAX_PASSWORD_LENGTH) {
      return NextResponse.json(
        { error: `newPassword must be at most ${MAX_PASSWORD_LENGTH} characters` },
        { status: 400 },
      )
    }

    const resetToken = await prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashResetToken(token.trim()) },
      select: { id: true, userId: true, expiresAt: true, usedAt: true },
    })

    // A token that does not exist, belongs to another user, was already used,
    // or has expired must all produce the same response so the endpoint does
    // not leak which condition failed.
    if (
      !resetToken ||
      resetToken.userId !== user.id ||
      resetToken.usedAt !== null ||
      resetToken.expiresAt.getTime() < Date.now()
    ) {
      return NextResponse.json({ error: INVALID_TOKEN_ERROR }, { status: 400 })
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: hashPassword(newPassword) },
    })

    await prisma.passwordResetToken.update({
      where: { id: resetToken.id },
      data: { usedAt: new Date() },
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    logger.error({ err: error }, 'POST /auth/password/reset-confirm error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
