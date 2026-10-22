import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { requireWalletActor, requireWalletSigner } from '@/app/api/_lib/collective-wallet-auth'

type RouteContext = { params: Promise<{ id: string; proposalId: string }> }

/** Once a proposal is being (or has been) submitted on-chain it can no longer be withdrawn. */
const NON_CANCELLABLE_STATUSES = ['executing', 'executed', 'cancelled']

/**
 * POST /api/collective-wallets/[id]/proposals/[proposalId]/cancel
 * Lets the original proposer withdraw a proposal before execution.
 * Existing signatures are kept for audit.
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const auth = await requireWalletActor(request)
    if ('response' in auth) return auth.response

    const { id, proposalId } = await params
    const access = await requireWalletSigner(id, auth.actor.id)
    if ('response' in access) return access.response

    const proposal = await prisma.multisigProposal.findFirst({
      where: { id: proposalId, walletId: id },
      select: { id: true, proposerId: true, status: true },
    })
    if (!proposal) return NextResponse.json({ error: 'Proposal not found' }, { status: 404 })

    if (proposal.proposerId !== auth.actor.id) {
      return NextResponse.json(
        { error: 'Forbidden: only the proposer can cancel this proposal', code: 'NOT_PROPOSER' },
        { status: 403 }
      )
    }

    if (NON_CANCELLABLE_STATUSES.includes(proposal.status)) {
      return NextResponse.json(
        { error: `Proposal cannot be cancelled from status "${proposal.status}"` },
        { status: 409 }
      )
    }

    // Guard on status in the write itself so a proposal that a concurrent
    // signature just pushed into "executing" is never cancelled mid-flight.
    const result = await prisma.multisigProposal.updateMany({
      where: { id: proposal.id, status: { notIn: NON_CANCELLABLE_STATUSES } },
      data: { status: 'cancelled', lastError: null },
    })
    if (result.count === 0) {
      return NextResponse.json(
        { error: 'Proposal can no longer be cancelled' },
        { status: 409 }
      )
    }

    logger.info(
      { walletId: id, proposalId: proposal.id, proposerId: auth.actor.id },
      'Multisig proposal cancelled'
    )

    return NextResponse.json({ proposalId: proposal.id, status: 'cancelled' })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/collective-wallets/[id]/proposals/[proposalId]/cancel error')
    return NextResponse.json({ error: 'Failed to cancel proposal' }, { status: 500 })
  }
}
