import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { isUniqueConstraintError } from '@/app/api/_lib/collective-wallet-auth'
import { logger } from '@/lib/logger'
import { verifyAuthToken } from '@/lib/auth'

type RouteContext = { params: Promise<{ id: string }> }

async function loadEligibleRecovery(request: NextRequest, recoveryId: string) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) {
    return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) } as const
  }

  const claims = await verifyAuthToken(authToken)
  if (!claims) {
    return { response: NextResponse.json({ error: 'Invalid token' }, { status: 401 }) } as const
  }

  const actor = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!actor) {
    return { response: NextResponse.json({ error: 'User not found' }, { status: 404 }) } as const
  }
  if (actor.role !== 'admin') {
    return { response: NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 }) } as const
  }

  const recovery = await prisma.emergencyRecovery.findUnique({
    where: { id: recoveryId },
    include: {
      wallet: { select: { signers: { select: { userId: true } } } },
      approvals: { orderBy: { createdAt: 'asc' } },
    },
  })
  if (!recovery) {
    return { response: NextResponse.json({ error: 'Emergency recovery not found' }, { status: 404 }) } as const
  }
  if (!recovery.wallet.signers.some((signer) => signer.userId === actor.id)) {
    return {
      response: NextResponse.json(
        { error: 'Forbidden: only admin signers on this wallet may review this recovery' },
        { status: 403 },
      ),
    } as const
  }

  return { actor, recovery } as const
}

export async function GET(request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  try {
    const { id } = await params
    const result = await loadEligibleRecovery(request, id)
    if (result.response) return result.response

    return NextResponse.json({
      recoveryId: result.recovery.id,
      status: result.recovery.status,
      approvals: result.recovery.approvals.map((approval) => ({
        approverId: approval.approverId,
        decision: approval.decision,
        note: approval.note,
        createdAt: approval.createdAt,
      })),
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/wallet-signers/emergency-recovery/[id]/approvals error')
    return NextResponse.json({ error: 'Failed to fetch emergency recovery approvals' }, { status: 500 })
  }
}

export async function POST(request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  try {
    const { id } = await params
    const result = await loadEligibleRecovery(request, id)
    if (result.response) return result.response

    if (result.recovery.status !== 'pending' || result.recovery.expiresAt <= new Date()) {
      return NextResponse.json({ error: 'Emergency recovery is not accepting approvals' }, { status: 409 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const decision = (body as { decision?: unknown } | null)?.decision
    const rawNote = (body as { note?: unknown } | null)?.note
    if (decision !== 'approve' && decision !== 'reject') {
      return NextResponse.json({ error: 'decision must be approve or reject' }, { status: 400 })
    }
    if (rawNote !== undefined && rawNote !== null && typeof rawNote !== 'string') {
      return NextResponse.json({ error: 'note must be a string' }, { status: 400 })
    }

    const existingApproval = await prisma.emergencyRecoveryApproval.findUnique({
      where: { recoveryId_approverId: { recoveryId: result.recovery.id, approverId: result.actor.id } },
    })
    if (existingApproval) {
      return NextResponse.json({ error: 'You have already submitted a decision for this recovery' }, { status: 409 })
    }

    try {
      const approval = await prisma.emergencyRecoveryApproval.create({
        data: {
          recoveryId: result.recovery.id,
          approverId: result.actor.id,
          decision,
          note: typeof rawNote === 'string' && rawNote.trim() ? rawNote.trim() : null,
        },
      })
      return NextResponse.json({ approval }, { status: 201 })
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return NextResponse.json({ error: 'You have already submitted a decision for this recovery' }, { status: 409 })
      }
      throw error
    }
  } catch (error) {
    logger.error({ err: error }, 'POST /api/wallet-signers/emergency-recovery/[id]/approvals error')
    return NextResponse.json({ error: 'Failed to submit emergency recovery approval' }, { status: 500 })
  }
}