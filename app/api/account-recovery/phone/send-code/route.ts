import { NextRequest, NextResponse } from 'next/server'
import { randomInt } from 'crypto'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export const PHONE_CODE_TTL_MS = 10 * 60 * 1000 // 10 minutes
export const PHONE_SEND_WINDOW_MS = 15 * 60 * 1000 // 15-minute window
export const MAX_PHONE_SENDS_PER_WINDOW = 3

const E164_PHONE_REGEX = /^\+?[1-9]\d{6,14}$/

const userSendTimestamps = new Map<string, number[]>()
const phoneSendTimestamps = new Map<string, number[]>()

export function resetPhoneSendRateLimitState(): void {
  userSendTimestamps.clear()
  phoneSendTimestamps.clear()
}

function generateSixDigitCode(): string {
  return String(randomInt(100000, 1000000))
}

function maskPhone(phone: string): string {
  const digits = phone.trim()
  if (digits.length <= 4) return '****'
  return `${digits.slice(0, 3)}****${digits.slice(-2)}`
}

function checkAndRecordSendRateLimit(
  userId: string,
  phone: string,
  nowMs: number,
): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  const windowStart = nowMs - PHONE_SEND_WINDOW_MS

  const userHistory = (userSendTimestamps.get(userId) ?? []).filter(
    (t) => t > windowStart,
  )
  const phoneHistory = (phoneSendTimestamps.get(phone) ?? []).filter(
    (t) => t > windowStart,
  )

  if (
    userHistory.length >= MAX_PHONE_SENDS_PER_WINDOW ||
    phoneHistory.length >= MAX_PHONE_SENDS_PER_WINDOW
  ) {
    const oldestRelevant = Math.min(
      userHistory[0] ?? nowMs,
      phoneHistory[0] ?? nowMs,
    )
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((oldestRelevant + PHONE_SEND_WINDOW_MS - nowMs) / 1000),
    )
    return { allowed: false, retryAfterSeconds }
  }

  userHistory.push(nowMs)
  phoneHistory.push(nowMs)
  userSendTimestamps.set(userId, userHistory)
  phoneSendTimestamps.set(phone, phoneHistory)

  return { allowed: true }
}

async function resolveAuthenticatedUser(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: 'Unauthorized', status: 401 as const, user: null }
  }
  const token = authHeader.slice(7).trim()
  if (!token) {
    return { error: 'Unauthorized', status: 401 as const, user: null }
  }

  const claims = await verifyAuthToken(token)
  if (!claims) {
    return { error: 'Unauthorized', status: 401 as const, user: null }
  }

  let userId = claims.userId
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

    if (!dbUser) {
      return { error: 'User not found', status: 404 as const, user: null }
    }
    userId = dbUser.id
  }

  return { error: null, status: 200 as const, user: { id: userId } }
}

/**
 * POST /api/account-recovery/phone/send-code
 * Generates and dispatches a short numeric verification code for phone account recovery:
 * - Generates a 6-digit numeric code and a bounded `expiresAt` (10 minutes), never returning the raw code in the response.
 * - Rate-limits how often a new code can be requested for the same user or phone number to prevent SMS abuse.
 * - Invalidates any prior unverified codes for the same user when a new one is issued.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await resolveAuthenticatedUser(req)
    if (auth.error || !auth.user) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Invalid JSON request body' },
        { status: 400 },
      )
    }

    const rawPhone = typeof body.phone === 'string' ? body.phone.trim() : ''
    if (
      !rawPhone ||
      rawPhone.length > 20 ||
      !E164_PHONE_REGEX.test(rawPhone)
    ) {
      return NextResponse.json(
        {
          error:
            'phone is required and must be a valid phone number (e.g. +14155550100)',
          code: 'INVALID_PHONE_NUMBER',
        },
        { status: 400 },
      )
    }

    const phone = rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`
    const nowMs = Date.now()

    // 1. Rate-limit per user and per phone number to prevent SMS abuse
    const rateCheck = checkAndRecordSendRateLimit(auth.user.id, phone, nowMs)
    if (!rateCheck.allowed) {
      return NextResponse.json(
        {
          error:
            'Too many verification code requests. Please wait before requesting another SMS code.',
          code: 'PHONE_VERIFICATION_RATE_LIMITED',
          retryAfterSeconds: rateCheck.retryAfterSeconds,
        },
        {
          status: 429,
          headers: {
            'Retry-After': String(rateCheck.retryAfterSeconds),
          },
        },
      )
    }

    // 2. Invalidate any prior unverified codes for the same user before issuing the new one
    let invalidatedPriorCount = 0
    if (typeof prisma.recoveryPhoneVerification?.updateMany === 'function') {
      const updated = await prisma.recoveryPhoneVerification.updateMany({
        where: {
          userId: auth.user.id,
          verified: false,
        },
        data: {
          expiresAt: new Date(0),
        },
      })
      invalidatedPriorCount = updated?.count ?? 0
    }
    if (typeof prisma.recoveryPhoneVerification?.deleteMany === 'function') {
      const deleted = await prisma.recoveryPhoneVerification.deleteMany({
        where: {
          userId: auth.user.id,
          verified: false,
        },
      })
      if (!invalidatedPriorCount && deleted?.count) {
        invalidatedPriorCount = deleted.count
      }
    }

    // 3. Generate short 6-digit numeric code and bounded expiresAt
    const code = generateSixDigitCode()
    const expiresAt = new Date(nowMs + PHONE_CODE_TTL_MS)

    const created = await prisma.recoveryPhoneVerification.create({
      data: {
        userId: auth.user.id,
        phone,
        code,
        expiresAt,
        verified: false,
      },
    })

    logger?.info?.(
      {
        verificationId: created.id,
        userId: auth.user.id,
        maskedPhone: maskPhone(phone),
        expiresAt: expiresAt.toISOString(),
      },
      'Recovery phone verification code generated and queued for SMS delivery',
    )

    // Never return the raw `code` in the HTTP response
    return NextResponse.json(
      {
        sent: true,
        verificationId: created.id,
        userId: created.userId,
        phone: created.phone,
        maskedPhone: maskPhone(created.phone),
        expiresAt: new Date(created.expiresAt ?? expiresAt).toISOString(),
        ttlSeconds: Math.floor(PHONE_CODE_TTL_MS / 1000),
        invalidatedPriorCount,
      },
      { status: 201 },
    )
  } catch (err) {
    logger?.error?.({ err }, 'POST /api/account-recovery/phone/send-code error')
    return NextResponse.json(
      { error: 'Failed to send phone recovery verification code' },
      { status: 500 },
    )
  }
}
