import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const TOKEN_TTL_MS = 30 * 60 * 1000
// One generic response for every outcome so the endpoint cannot be used to
// probe which email addresses have accounts.
const GENERIC_MESSAGE =
  'If an account exists for this email, a password reset link has been sent'

export async function POST(request: NextRequest) {
  try {
    // Deliberately unauthenticated: a password reset is requested by a user
    // who cannot log in. Identification is by email only.
    const body = await request.json()
    const { email } = body

    if (!email || typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
      return NextResponse.json({ error: 'A valid email is required' }, { status: 400 })
    }

    const user = await prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
    })

    if (user) {
      // Keep at most one active token: a fresh request supersedes any
      // outstanding unused ones instead of accumulating live tokens.
      const token = randomBytes(32).toString('hex')
      const expiresAt = new Date(Date.now() + TOKEN_TTL_MS)

      await prisma.$transaction([
        (prisma as any).passwordResetToken.updateMany({
          where: { userId: user.id, used: false },
          data: { used: true },
        }),
        (prisma as any).passwordResetToken.create({
          data: { userId: user.id, token, expiresAt, used: false },
        }),
      ])

      // Delivery goes through the mailer; the token itself is never
      // included in the API response.
      logger.info({ userId: user.id }, 'Password reset requested')
    }

    return NextResponse.json({ message: GENERIC_MESSAGE }, { status: 202 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-d/auth/password/reset-request error')
    return NextResponse.json({ error: 'Failed to process reset request' }, { status: 500 })
  }
}
