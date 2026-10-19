import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { requireWalletActor, requireWalletSigner } from '@/app/api/_lib/collective-wallet-auth'

type RouteContext = { params: Promise<{ id: string; proposalId: string }> }

export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const auth = await requireWalletActor(request)
    if ('response' in auth) return auth.response

    const { id, proposalId } = await params
    const access = await requireWalletSigner(id, auth.actor.id)
    if ('response' in access) return access.response

    const proposal = await prisma.multisigProposal.findFirst({
      where: { id: proposalId, walletId: id },
      select: {
        id: true,
        status: true,
        broadcast: {
          select: {
            id: true,
            txHash: true,
            network: true,
            status: true,
            broadcastAt: true,
            confirmedAt: true,
            failureReason: true,
          },
        },
      },
    })
    if (!proposal) return NextResponse.json({ error: 'Proposal not found' }, { status: 404 })
    if (!proposal.broadcast) return NextResponse.json({ error: 'Broadcast not found' }, { status: 404 })

    const broadcast = proposal.broadcast
    const status = broadcast.status === 'failed'
      ? 'failed'
      : broadcast.confirmedAt
        ? 'confirmed'
        : 'pending'

    return NextResponse.json({
      proposalId: proposal.id,
      status,
      txHash: broadcast.txHash,
      network: broadcast.network,
      broadcastAt: broadcast.broadcastAt,
      confirmedAt: broadcast.confirmedAt,
      failureReason: status === 'failed' ? broadcast.failureReason : null,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/collective-wallets/[id]/proposals/[proposalId]/broadcast-status error')
    return NextResponse.json({ error: 'Failed to fetch broadcast status' }, { status: 500 })
  }
}