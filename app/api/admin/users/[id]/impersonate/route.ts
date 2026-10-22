import { NextRequest, NextResponse } from 'next/server'
import crypto, { createHmac } from 'crypto'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { verifyAuthToken } from '@/lib/auth'

const DEFAULT_SESSION_DURATION_MINUTES = 30
const IMPERSONATION_SECRET =
  process.env.AUTH_SECRET || process.env.AUDIT_SECRET || 'lancepay-impersonation-secret-key-prod'

const impersonateRequestSchema = z.object({
  justification: z
    .string()
    .trim()
    .min(5, 'Justification must be at least 5 characters long')
    .max(500, 'Justification must not exceed 500 characters'),
  durationMinutes: z.number().int().min(5).max(120).default(DEFAULT_SESSION_DURATION_MINUTES),
})

export function signImpersonationToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = createHmac('sha256', IMPERSONATION_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url')
  return `${header}.${body}.${signature}`
}

export function decodeImpersonationToken(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [header, body, signature] = parts
    const expectedSig = createHmac('sha256', IMPERSONATION_SECRET)
      .update(`${header}.${body}`)
      .digest('base64url')
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
      return null
    }
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

async function getAuthenticatedAdmin(
  request: NextRequest,
): Promise<{ id: string; email: string } | null> {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null

  const claims = await verifyAuthToken(authToken)
  if (!claims?.userId) return null

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true, email: true, role: true },
  })

  if (!user || user.role !== 'admin') {
    return null
  }

  return { id: user.id, email: user.email }
}

/**
 * POST /api/admin/users/[id]/impersonate
 *
 * Opens a short-lived, time-boxed impersonation session for support staff to reproduce user issues.
 * - Requires a justification string recorded in the audit trail.
 * - Issues a signed session token encoding both acting admin and target user.
 * - Rejects impersonating a user with an active elevated security context (e.g. pending withdrawal confirmation).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: targetUserId } = await params
    if (!targetUserId || typeof targetUserId !== 'string' || targetUserId.trim() === '') {
      return NextResponse.json({ error: 'Target user ID is required' }, { status: 400 })
    }

    const admin = await getAuthenticatedAdmin(request)
    if (!admin) {
      return NextResponse.json(
        { error: 'Forbidden: platform admin access required', code: 'FORBIDDEN' },
        { status: 403 },
      )
    }

    if (targetUserId === admin.id) {
      return NextResponse.json(
        { error: 'Cannot impersonate your own account', code: 'CANNOT_IMPERSONATE_SELF' },
        { status: 400 },
      )
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const rawPayload = (body ?? {}) as Record<string, unknown>
    // Accept justification (or fallback to reason if supplied)
    const normalizedPayload = {
      justification: rawPayload.justification ?? rawPayload.reason,
      durationMinutes: rawPayload.durationMinutes,
    }

    const parsed = impersonateRequestSchema.safeParse(normalizedPayload)
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Justification string is required for audit trail',
          code: 'JUSTIFICATION_REQUIRED',
          details: parsed.error.flatten().fieldErrors,
        },
        { status: 400 },
      )
    }

    const { justification, durationMinutes } = parsed.data

    // Check target user exists
    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, email: true, name: true, role: true },
    })

    if (!targetUser) {
      return NextResponse.json({ error: 'Target user not found', code: 'USER_NOT_FOUND' }, { status: 404 })
    }

    // Security preflight: Check for active elevated security context
    // 1. Pending withdrawal transaction
    const pendingWithdrawal = await prisma.withdrawalTransaction.findFirst({
      where: {
        userId: targetUserId,
        status: { in: ['pending', 'interactive', 'submitted', 'pending_confirmation'] },
      },
      select: { id: true, status: true, amount: true, asset: true, createdAt: true },
    })

    if (pendingWithdrawal) {
      return NextResponse.json(
        {
          error:
            'Cannot impersonate user with active elevated security context: pending withdrawal confirmation',
          code: 'ELEVATED_SECURITY_CONTEXT',
          reason: 'pending_withdrawal_confirmation',
          details: {
            withdrawalId: pendingWithdrawal.id,
            status: pendingWithdrawal.status,
            amount: pendingWithdrawal.amount.toString(),
            asset: pendingWithdrawal.asset,
          },
        },
        { status: 403 },
      )
    }

    // 2. Pending emergency recovery request
    const pendingRecovery = await prisma.emergencyRecoveryRequest.findFirst({
      where: {
        requestedById: targetUserId,
        status: 'pending',
      },
      select: { id: true, status: true },
    })

    if (pendingRecovery) {
      return NextResponse.json(
        {
          error:
            'Cannot impersonate user with active elevated security context: pending emergency recovery request',
          code: 'ELEVATED_SECURITY_CONTEXT',
          reason: 'pending_emergency_recovery',
          details: {
            recoveryRequestId: pendingRecovery.id,
          },
        },
        { status: 403 },
      )
    }

    const now = new Date()
    const expiresAt = new Date(now.getTime() + durationMinutes * 60_000)
    const sessionId = `imp_${crypto.randomBytes(8).toString('hex')}_${now.getTime()}`

    // Encode both acting admin and target user in the signed session token
    const tokenPayload = {
      sessionId,
      type: 'impersonation_session',
      admin: {
        id: admin.id,
        email: admin.email,
      },
      targetUser: {
        id: targetUser.id,
        email: targetUser.email,
        role: targetUser.role,
      },
      justification,
      iat: Math.floor(now.getTime() / 1000),
      exp: Math.floor(expiresAt.getTime() / 1000),
    }

    const token = signImpersonationToken(tokenPayload)

    // Record in database audit trail
    const session = await prisma.impersonationSession.create({
      data: {
        id: sessionId,
        adminId: admin.id,
        targetUserId: targetUser.id,
        token,
        justification,
        expiresAt,
      },
      select: {
        id: true,
        adminId: true,
        targetUserId: true,
        token: true,
        justification: true,
        expiresAt: true,
        createdAt: true,
      },
    })

    logger.info(
      {
        sessionId,
        adminId: admin.id,
        targetUserId: targetUser.id,
        durationMinutes,
      },
      'Admin created impersonation session',
    )

    return NextResponse.json(
      {
        session: {
          id: session.id,
          token: session.token,
          adminId: admin.id,
          targetUserId: targetUser.id,
          targetUserEmail: targetUser.email,
          justification: session.justification,
          expiresAt: session.expiresAt.toISOString(),
          durationMinutes,
        },
      },
      { status: 201 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/admin/users/[id]/impersonate error')
    return NextResponse.json({ error: 'Failed to create impersonation session' }, { status: 500 })
  }
}
