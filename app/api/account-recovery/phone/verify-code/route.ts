import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export const MAX_VERIFY_ATTEMPTS_PER_RECORD = 5

// Per-verification-record attempt counter to prevent brute-forcing the short numeric code
const verificationAttemptCounts = new Map<string, number>()

export function resetPhoneVerifyAttemptState(): void {
  verificationAttemptCounts.clear()
}

export function getPhoneVerifyAttemptCount(verificationId: string): number {
  return verificationAttemptCounts.get(verificationId) ?? 0
}

function compareCodesTimingSafe(expected: string, provided: string): boolean {
  const a = Buffer.from(expected)
  const b = Buffer.from(provided)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

async function resolveOptionalAuthenticatedUser(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return { user: null }
  }
  const token = authHeader.slice(7).trim()
  if (!token) return { user: null }

  const claims = await verifyAuthToken(token)
  if (!claims) return { user: null }

  if (typeof prisma.user?.findUnique === 'function') {
    const dbUser =
      (await prisma.user.findUnique({
        where: { privyId: claims.userId },
        select: { id: true },
      })) ??
      (await prisma.user.findUnique({
        where: { id: claims.userId },
        select: { id: true },
      }))
    if (dbUser) return { user: { id: dbUser.id } }
  }

  return { user: { id: claims.userId } }
}

/**
 * POST /api/account-recovery/phone/verify-code
 * Verifies a phone recovery code (`RecoveryPhoneVerification`) and marks it verified:
 * - Rejects an expired code with a distinct expired response (`VERIFICATION_CODE_EXPIRED`).
 * - Rejects a code that has already been marked verified (`VERIFICATION_CODE_ALREADY_USED`, consumable once).
 * - Rate-limits verification attempts per verification record (`MAX_VERIFY_ATTEMPTS_PER_RECORD`) to prevent brute-forcing.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await resolveOptionalAuthenticatedUser(req)

    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Invalid JSON request body' },
        { status: 400 },
      )
    }

    const submittedCode =
      typeof body.code === 'string'
        ? body.code.trim()
        : typeof body.code === 'number'
          ? String(body.code)
          : ''

    if (!submittedCode || !/^\d{4,10}$/.test(submittedCode)) {
      return NextResponse.json(
        {
          error: 'code is required and must be a numeric verification code',
          code: 'INVALID_VERIFICATION_CODE_FORMAT',
        },
        { status: 400 },
      )
    }

    const verificationId =
      typeof body.verificationId === 'string'
        ? body.verificationId.trim()
        : typeof body.id === 'string'
          ? body.id.trim()
          : ''
    const phone =
      typeof body.phone === 'string' ? body.phone.trim() : undefined
    const targetUserId =
      auth.user?.id ??
      (typeof body.userId === 'string' ? body.userId.trim() : undefined)

    let record: Record<string, any> | null = null
    if (
      verificationId &&
      typeof prisma.recoveryPhoneVerification?.findUnique === 'function'
    ) {
      record = await prisma.recoveryPhoneVerification.findUnique({
        where: { id: verificationId },
      })
    } else if (
      typeof prisma.recoveryPhoneVerification?.findFirst === 'function'
    ) {
      const where: Record<string, unknown> = {}
      if (verificationId) where.id = verificationId
      if (targetUserId) where.userId = targetUserId
      if (phone) where.phone = phone

      if (Object.keys(where).length === 0) {
        return NextResponse.json(
          {
            error: 'verificationId, userId, or phone is required',
            code: 'MISSING_VERIFICATION_IDENTIFIER',
          },
          { status: 400 },
        )
      }

      record = await prisma.recoveryPhoneVerification.findFirst({
        where,
        orderBy: { createdAt: 'desc' },
      })
    }

    if (!record) {
      return NextResponse.json(
        {
          error: 'Phone verification record not found',
          code: 'VERIFICATION_NOT_FOUND',
        },
        { status: 404 },
      )
    }

    if (auth.user && record.userId && record.userId !== auth.user.id) {
      return NextResponse.json(
        {
          error:
            'Forbidden: verification record belongs to a different account',
          code: 'FORBIDDEN_VERIFICATION_OWNER',
        },
        { status: 403 },
      )
    }

    // 1. Reject a code that has already been marked verified (consumable once)
    if (record.verified === true) {
      return NextResponse.json(
        {
          error:
            'Verification code has already been verified and cannot be reused',
          code: 'VERIFICATION_CODE_ALREADY_USED',
          alreadyVerified: true,
        },
        { status: 409 },
      )
    }

    // 2. Reject an expired code with a distinct expired response
    const expiresAtMs = record.expiresAt
      ? new Date(record.expiresAt).getTime()
      : 0
    if (!expiresAtMs || expiresAtMs <= Date.now()) {
      return NextResponse.json(
        {
          error: 'Verification code has expired. Please request a new code.',
          code: 'VERIFICATION_CODE_EXPIRED',
          expired: true,
          expiresAt: record.expiresAt
            ? new Date(record.expiresAt).toISOString()
            : null,
        },
        { status: 410 },
      )
    }

    // 3. Rate-limit verification attempts per verification record
    const recordKey = String(record.id)
    const priorAttempts = verificationAttemptCounts.get(recordKey) ?? 0
    if (priorAttempts >= MAX_VERIFY_ATTEMPTS_PER_RECORD) {
      return NextResponse.json(
        {
          error:
            'Maximum verification attempts exceeded for this code. Please request a new code.',
          code: 'VERIFICATION_ATTEMPTS_EXCEEDED',
          maxAttempts: MAX_VERIFY_ATTEMPTS_PER_RECORD,
          attemptsRemaining: 0,
        },
        { status: 429 },
      )
    }

    const currentAttempts = priorAttempts + 1
    verificationAttemptCounts.set(recordKey, currentAttempts)

    // 4. Verify numeric code using timing-safe comparison
    const isMatch = compareCodesTimingSafe(
      String(record.code ?? ''),
      submittedCode,
    )
    if (!isMatch) {
      const remaining = Math.max(
        0,
        MAX_VERIFY_ATTEMPTS_PER_RECORD - currentAttempts,
      )
      return NextResponse.json(
        {
          error: 'Invalid verification code',
          code: 'INVALID_VERIFICATION_CODE',
          attemptsRemaining: remaining,
        },
        { status: 400 },
      )
    }

    // 5. Mark verified atomically (consumable once)
    if (typeof prisma.recoveryPhoneVerification?.updateMany === 'function') {
      const claimed = await prisma.recoveryPhoneVerification.updateMany({
        where: { id: record.id, verified: false },
        data: { verified: true },
      })
      if (claimed.count === 0) {
        return NextResponse.json(
          {
            error:
              'Verification code has already been verified and cannot be reused',
            code: 'VERIFICATION_CODE_ALREADY_USED',
            alreadyVerified: true,
          },
          { status: 409 },
        )
      }
    } else if (typeof prisma.recoveryPhoneVerification?.update === 'function') {
      await prisma.recoveryPhoneVerification.update({
        where: { id: record.id },
        data: { verified: true },
      })
    }

    return NextResponse.json({
      verified: true,
      verificationId: record.id,
      userId: record.userId,
      phone: record.phone,
    })
  } catch (err) {
    logger?.error?.({ err }, 'POST /api/account-recovery/phone/verify-code error')
    return NextResponse.json(
      { error: 'Failed to verify phone recovery code' },
      { status: 500 },
    )
  }
}
