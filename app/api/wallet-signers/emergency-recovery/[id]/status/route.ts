import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { isAdmin } from '@/lib/authorization'

/**
 * Derives a user-facing status from the stored request status plus how many
 * approvals have been collected against how many are required.
 */
function deriveDisplayStatus(
  status: string,
  approvedCount: number,
  requiredApprovals: number,
): 'pending' | 'approved-and-executing' | 'executed' | 'rejected' {
  if (status === 'rejected') return 'rejected'
  if (status === 'executed') return 'executed'
  if (status === 'executing' || approvedCount >= requiredApprovals) {
    return 'approved-and-executing'
  }
  return 'pending'
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const actor = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!actor) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { id } = await params
    if (!id || id.trim() === '') {
      return NextResponse.json({ error: 'Recovery request ID is required' }, { status: 400 })
    }

    const recoveryRequest = await prisma.emergencyRecoveryRequest.findUnique({
      where: { id },
      include: {
        approvals: true,
        wallet: { include: { signers: true } },
      },
    })
    if (!recoveryRequest) {
      return NextResponse.json({ error: 'Emergency recovery request not found' }, { status: 404 })
    }

    // Visibility is restricted to admins in the approval chain: those who are
    // eligible to approve (admin signers on the wallet) or who already cast a
    // decision on this specific request.
    const isAdminActor = isAdmin(actor)
    const isEligibleApprover =
      isAdminActor && recoveryRequest.wallet.signers.some((s) => s.userId === actor.id)
    const hasApproved = recoveryRequest.approvals.some((a) => a.adminId === actor.id)

    if (!isEligibleApprover && !hasApproved) {
      return NextResponse.json(
        { error: 'Forbidden: only admins in the approval chain can view this request' },
        { status: 403 },
      )
    }

    const approvedCount = recoveryRequest.approvals.filter((a) => a.decision === 'approved').length
    const rejectedCount = recoveryRequest.approvals.filter((a) => a.decision === 'rejected').length
    const displayStatus = deriveDisplayStatus(
      recoveryRequest.status,
      approvedCount,
      recoveryRequest.requiredApprovals,
    )

    logger.info(
      { requestId: recoveryRequest.id, actorId: actor.id, displayStatus },
      'Emergency recovery status viewed',
    )

    return NextResponse.json({
      requestId: recoveryRequest.id,
      walletId: recoveryRequest.walletId,
      status: displayStatus,
      requiredApprovals: recoveryRequest.requiredApprovals,
      approvalsCollected: approvedCount,
      rejections: rejectedCount,
      approvals: recoveryRequest.approvals.map((a) => ({
        adminId: a.adminId,
        decision: a.decision,
        decidedAt: a.createdAt,
      })),
      createdAt: recoveryRequest.createdAt,
      executedAt: recoveryRequest.executedAt,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/wallet-signers/emergency-recovery/[id]/status error')
    return NextResponse.json(
      { error: 'Failed to load emergency recovery status' },
      { status: 500 },
    )
  }
}
