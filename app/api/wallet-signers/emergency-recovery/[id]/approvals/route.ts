import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { MIN_APPROVALS } from '../../route'

export const ALLOWED_RECOVERY_DECISIONS = new Set(['approve', 'reject'] as const)
export type RecoveryDecision = 'approve' | 'reject'

type RouteContext = {
  params: Promise<{ id: string }> | { id: string }
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002'
  )
}

async function resolveRecoveryId(context?: RouteContext): Promise<string> {
  if (!context?.params) return ''
  const resolved = await Promise.resolve(context.params)
  return (resolved?.id ?? '').trim()
}

async function resolveAuthenticatedUser(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: 'Unauthorized', status: 401 as const, actor: null }
  }
  const token = authHeader.slice(7).trim()
  if (!token) {
    return { error: 'Unauthorized', status: 401 as const, actor: null }
  }

  const claims = await verifyAuthToken(token)
  if (!claims) {
    return { error: 'Invalid token', status: 401 as const, actor: null }
  }

  const actor =
    (await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true, email: true, role: true },
    })) ??
    (await prisma.user.findUnique({
      where: { id: claims.userId },
      select: { id: true, email: true, role: true },
    }))

  if (!actor) {
    return { error: 'User not found', status: 404 as const, actor: null }
  }

  return { error: null, status: 200 as const, actor }
}

function isEligibleRecoveryReviewer(
  actor: { id: string; role?: string | null },
  recovery: {
    initiatorId?: string | null
    wallet?: { signers?: Array<{ userId: string }> } | null
  },
): { eligible: true } | { eligible: false; reason: string; code: string } {
  if ((actor.role ?? '').trim().toLowerCase() !== 'admin') {
    return {
      eligible: false,
      reason: 'Forbidden: admin role required',
      code: 'FORBIDDEN_ADMIN_REQUIRED',
    }
  }

  if (recovery.initiatorId && recovery.initiatorId === actor.id) {
    return {
      eligible: false,
      reason:
        'Forbidden: the initiating admin cannot approve or reject their own emergency recovery request',
      code: 'FORBIDDEN_SELF_APPROVAL',
    }
  }

  const walletSigners = recovery.wallet?.signers
  if (Array.isArray(walletSigners)) {
    const isWalletSigner = walletSigners.some((s) => s.userId === actor.id)
    if (!isWalletSigner) {
      return {
        eligible: false,
        reason:
          'Forbidden: only admins eligible to review this recovery request (wallet signers) may submit or view decisions',
        code: 'FORBIDDEN_NOT_ELIGIBLE_REVIEWER',
      }
    }
  }

  return { eligible: true }
}

/**
 * GET /api/wallet-signers/emergency-recovery/[id]/approvals
 * Lists approval/rejection decisions for an emergency recovery request.
 */
export async function GET(req: NextRequest, context: RouteContext) {
  try {
    const auth = await resolveAuthenticatedUser(req)
    if (auth.error || !auth.actor) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const recoveryId = await resolveRecoveryId(context)
    if (!recoveryId) {
      return NextResponse.json(
        { error: 'Recovery ID is required' },
        { status: 400 },
      )
    }

    const recovery = await prisma.emergencyRecovery.findUnique({
      where: { id: recoveryId },
      include: {
        approvals: { orderBy: { createdAt: 'asc' } },
        wallet: { include: { signers: true } },
      },
    })

    if (!recovery) {
      return NextResponse.json(
        { error: 'Emergency recovery request not found' },
        { status: 404 },
      )
    }

    const isInitiator = recovery.initiatorId === auth.actor.id
    const hasAlreadyVoted = (recovery.approvals ?? []).some(
      (a: { approverId: string }) => a.approverId === auth.actor.id,
    )
    const eligibility = isEligibleRecoveryReviewer(auth.actor, recovery)

    if (
      (auth.actor.role ?? '').toLowerCase() !== 'admin' ||
      (!eligibility.eligible && !isInitiator && !hasAlreadyVoted)
    ) {
      return NextResponse.json(
        {
          error:
            'Forbidden: only admins eligible for this recovery request may view approvals',
          code: 'FORBIDDEN_NOT_ELIGIBLE_REVIEWER',
        },
        { status: 403 },
      )
    }

    const approvals = (recovery.approvals ?? []).map(
      (a: Record<string, any>) => ({
        id: a.id,
        recoveryId: a.recoveryId,
        approverId: a.approverId,
        decision: a.decision,
        note: a.note ?? null,
        createdAt: a.createdAt ? new Date(a.createdAt).toISOString() : null,
      }),
    )

    const approveCount = approvals.filter(
      (a) => a.decision === 'approve',
    ).length
    const rejectCount = approvals.filter((a) => a.decision === 'reject').length

    return NextResponse.json({
      recoveryId: recovery.id,
      status: recovery.status,
      requiredApprovals: MIN_APPROVALS,
      approveCount,
      rejectCount,
      approvals,
    })
  } catch (err) {
    logger?.error?.(
      { err },
      'GET /api/wallet-signers/emergency-recovery/[id]/approvals error',
    )
    return NextResponse.json(
      { error: 'Failed to list emergency recovery approvals' },
      { status: 500 },
    )
  }
}

/**
 * POST /api/wallet-signers/emergency-recovery/[id]/approvals
 * Submits an admin approval or rejection decision (`EmergencyRecoveryApproval`):
 * - Enforces the unique `(recoveryId, approverId)` constraint so each admin can only approve or reject once.
 * - Validates `decision` is either `approve` or `reject`.
 * - Permits only admins eligible to review this specific recovery request.
 */
export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const auth = await resolveAuthenticatedUser(req)
    if (auth.error || !auth.actor) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const recoveryId = await resolveRecoveryId(context)
    if (!recoveryId) {
      return NextResponse.json(
        { error: 'Recovery ID is required' },
        { status: 400 },
      )
    }

    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Invalid JSON request body' },
        { status: 400 },
      )
    }

    const rawDecision =
      typeof body.decision === 'string'
        ? body.decision.trim().toLowerCase()
        : ''
    if (!ALLOWED_RECOVERY_DECISIONS.has(rawDecision as RecoveryDecision)) {
      return NextResponse.json(
        {
          error: "decision must be either 'approve' or 'reject'",
          code: 'INVALID_RECOVERY_DECISION',
        },
        { status: 400 },
      )
    }
    const decision = rawDecision as RecoveryDecision
    const note =
      typeof body.note === 'string' && body.note.trim()
        ? body.note.trim()
        : null

    const recovery = await prisma.emergencyRecovery.findUnique({
      where: { id: recoveryId },
      include: {
        approvals: true,
        wallet: { include: { signers: true } },
      },
    })

    if (!recovery) {
      return NextResponse.json(
        { error: 'Emergency recovery request not found' },
        { status: 404 },
      )
    }

    // 1. Check eligibility to review this specific recovery request
    const eligibility = isEligibleRecoveryReviewer(auth.actor, recovery)
    if (!eligibility.eligible) {
      return NextResponse.json(
        { error: eligibility.reason, code: eligibility.code },
        { status: 403 },
      )
    }

    if (recovery.status !== 'pending') {
      return NextResponse.json(
        {
          error: `Emergency recovery request is already '${recovery.status}' and cannot accept new decisions`,
          code: 'RECOVERY_NOT_PENDING',
        },
        { status: 409 },
      )
    }

    if (
      recovery.expiresAt &&
      new Date(recovery.expiresAt).getTime() <= Date.now()
    ) {
      return NextResponse.json(
        {
          error: 'Emergency recovery request has expired',
          code: 'RECOVERY_EXPIRED',
        },
        { status: 410 },
      )
    }

    // 2. Enforce unique (recoveryId, approverId) constraint so each admin can only decide once
    const existingInLoaded = (recovery.approvals ?? []).find(
      (a: { approverId: string }) => a.approverId === auth.actor.id,
    )
    if (existingInLoaded) {
      return NextResponse.json(
        {
          error:
            'You have already submitted a decision for this emergency recovery request',
          code: 'DUPLICATE_APPROVAL_DECISION',
        },
        { status: 409 },
      )
    }

    if (typeof prisma.emergencyRecoveryApproval?.findUnique === 'function') {
      const existingApproval =
        await prisma.emergencyRecoveryApproval.findUnique({
          where: {
            recoveryId_approverId: {
              recoveryId: recovery.id,
              approverId: auth.actor.id,
            },
          },
        })
      if (existingApproval) {
        return NextResponse.json(
          {
            error:
              'You have already submitted a decision for this emergency recovery request',
            code: 'DUPLICATE_APPROVAL_DECISION',
          },
          { status: 409 },
        )
      }
    }

    let createdApproval
    try {
      createdApproval = await prisma.emergencyRecoveryApproval.create({
        data: {
          recoveryId: recovery.id,
          approverId: auth.actor.id,
          decision,
          note,
        },
      })
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return NextResponse.json(
          {
            error:
              'You have already submitted a decision for this emergency recovery request',
            code: 'DUPLICATE_APPROVAL_DECISION',
          },
          { status: 409 },
        )
      }
      throw err
    }

    const priorApprovals = (recovery.approvals ?? []).filter(
      (a: { decision: string }) => a.decision === 'approve',
    ).length
    const totalApprovals =
      priorApprovals + (decision === 'approve' ? 1 : 0)

    let nextStatus = recovery.status
    if (decision === 'reject') {
      nextStatus = 'rejected'
    } else if (totalApprovals >= MIN_APPROVALS) {
      nextStatus = 'approved'
    }

    if (
      nextStatus !== recovery.status &&
      typeof prisma.emergencyRecovery?.update === 'function'
    ) {
      await prisma.emergencyRecovery.update({
        where: { id: recovery.id },
        data: {
          status: nextStatus,
          ...(nextStatus === 'rejected' ? { resolvedAt: new Date() } : {}),
        },
      })
    }

    return NextResponse.json(
      {
        approval: {
          id: createdApproval.id,
          recoveryId: createdApproval.recoveryId,
          approverId: createdApproval.approverId,
          decision: createdApproval.decision,
          note: createdApproval.note ?? null,
          createdAt: createdApproval.createdAt
            ? new Date(createdApproval.createdAt).toISOString()
            : null,
        },
        recoveryStatus: nextStatus,
        approvalsReceived: totalApprovals,
        requiredApprovals: MIN_APPROVALS,
      },
      { status: 201 },
    )
  } catch (err) {
    logger?.error?.(
      { err },
      'POST /api/wallet-signers/emergency-recovery/[id]/approvals error',
    )
    return NextResponse.json(
      { error: 'Failed to submit emergency recovery approval decision' },
      { status: 500 },
    )
  }
}
