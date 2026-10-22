import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { requireWalletActor, requireWalletSigner } from '@/app/api/_lib/collective-wallet-auth'

type RouteContext = { params: Promise<{ id: string; proposalId: string }> }

/** An execution that has not finished within this window is reported as stalled. */
export const EXECUTION_STALL_TIMEOUT_MS = 10 * 60 * 1000

/**
 * GET /api/collective-wallets/[id]/proposals/[proposalId]/status
 * Live execution progress for a proposal. Only wallet signers may view it.
 */
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
        expiresAt: true,
        executionStartedAt: true,
        executedAt: true,
        stellarTxHash: true,
        lastError: true,
        signatures: { select: { signerId: true } },
      },
    })
    if (!proposal) return NextResponse.json({ error: 'Proposal not found' }, { status: 404 })

    const signerIds = proposal.signatures.map((signature) => signature.signerId)
    const signers = signerIds.length
      ? await prisma.walletSigner.findMany({
          where: { walletId: id, userId: { in: signerIds } },
          select: { userId: true, weight: true },
        })
      : []
    const currentWeight = signers.reduce((total, signer) => total + signer.weight, 0)
    const requiredThreshold = access.wallet.threshold

    const now = Date.now()
    const stalled =
      proposal.executionStartedAt !== null &&
      proposal.executedAt === null &&
      now - proposal.executionStartedAt.getTime() > EXECUTION_STALL_TIMEOUT_MS

    return NextResponse.json({
      proposalId: proposal.id,
      status: proposal.status,
      signaturesCollected: signerIds.length,
      currentWeight,
      requiredThreshold,
      thresholdMet: currentWeight >= requiredThreshold,
      expiresAt: proposal.expiresAt,
      expired: proposal.status === 'pending' && proposal.expiresAt.getTime() <= now,
      executionStartedAt: proposal.executionStartedAt,
      executedAt: proposal.executedAt,
      stellarTxHash: proposal.stellarTxHash,
      lastError: proposal.lastError,
      stalled,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/collective-wallets/[id]/proposals/[proposalId]/status error')
    return NextResponse.json({ error: 'Failed to fetch proposal status' }, { status: 500 })
  }
}
