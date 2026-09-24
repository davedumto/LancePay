import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// Number of ledger closes required to consider the transaction final.
const REQUIRED_CONFIRMATIONS = 12
// Approximate ms between Stellar ledger closes (~5 s).
const MS_PER_CONFIRMATION = 5_000

type RouteContext = {
  params: Promise<{ id: string }> | { id: string }
}

async function resolveParams(context: RouteContext): Promise<{ id: string }> {
  const raw = context.params as { id: string } | Promise<{ id: string }>
  if (raw && typeof (raw as Promise<{ id: string }>).then === 'function') {
    return raw as Promise<{ id: string }>
  }
  return raw as { id: string }
}

/**
 * Derive how many confirmations a broadcast has, and whether it is final,
 * purely from the data we have in the database.
 *
 * Status semantics:
 *   "pending"   – submitted to the network; inclusion not yet observed.
 *                 We use time-elapsed as a proxy for ledger-close progress.
 *                 A pending record whose txHash is NULL means the network
 *                 has not yet propagated the tx — not a permanent failure.
 *   "confirmed" – finality reached.
 *   "failed"    – network rejected or tx was dropped.
 */
function computeConfirmations(
  status: string,
  broadcastAt: Date,
): { confirmations: number; confirmed: boolean; networkFailed: boolean } {
  if (status === 'confirmed') {
    return { confirmations: REQUIRED_CONFIRMATIONS, confirmed: true, networkFailed: false }
  }
  if (status === 'failed') {
    return { confirmations: 0, confirmed: false, networkFailed: true }
  }
  // pending — estimate progress from elapsed time
  const elapsedMs = Date.now() - broadcastAt.getTime()
  const confirmations = Math.max(
    0,
    Math.min(REQUIRED_CONFIRMATIONS - 1, Math.floor(elapsedMs / MS_PER_CONFIRMATION)),
  )
  return { confirmations, confirmed: false, networkFailed: false }
}

// ── GET /api/routes-d/onchain/multisig-broadcasts/[id]/confirmation ──
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { id } = await resolveParams(context)
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

    const broadcast = await prisma.multisigBroadcast.findUnique({
      where: { id },
      include: {
        proposal: {
          select: {
            id: true,
            walletId: true,
            proposerId: true,
            wallet: {
              select: {
                signers: { select: { userId: true } },
              },
            },
          },
        },
      },
    })

    if (!broadcast) {
      // Distinguish a missing record from a tx that just hasn't propagated yet:
      // if the caller passes a well-formed ID that simply isn't in our DB yet,
      // we return 404. Clients should retry on 404 during the propagation window.
      return NextResponse.json({ error: 'Broadcast not found' }, { status: 404 })
    }

    // Authorization: only wallet signers (including the proposer) may poll status.
    const signerUserIds = broadcast.proposal.wallet.signers.map((s) => s.userId)
    const isParticipant =
      broadcast.proposal.proposerId === user.id || signerUserIds.includes(user.id)

    if (!isParticipant) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { confirmations, confirmed, networkFailed } = computeConfirmations(
      broadcast.status,
      broadcast.broadcastAt,
    )

    return NextResponse.json({
      confirmation: {
        id: broadcast.id,
        proposalId: broadcast.proposalId,
        txHash: broadcast.txHash ?? null,
        network: broadcast.network,
        status: broadcast.status,
        // pending with a null txHash = network propagation delay — not a failure
        propagating: broadcast.status === 'pending' && broadcast.txHash === null,
        confirmations,
        requiredConfirmations: REQUIRED_CONFIRMATIONS,
        confirmed,
        networkFailed,
        failureReason: broadcast.failureReason ?? null,
        broadcastAt: broadcast.broadcastAt,
        confirmedAt: broadcast.confirmedAt ?? null,
      },
    })
  } catch (error) {
    logger.error(
      { err: error },
      'GET /api/routes-d/onchain/multisig-broadcasts/[id]/confirmation error',
    )
    return NextResponse.json({ error: 'Failed to fetch broadcast confirmation' }, { status: 500 })
  }
}
