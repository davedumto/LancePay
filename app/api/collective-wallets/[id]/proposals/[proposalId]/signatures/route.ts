import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import {
  SIGNER_USER_SELECT,
  requireWalletActor,
  requireWalletSigner,
} from '@/app/api/_lib/collective-wallet-auth'

type RouteContext = { params: Promise<{ id: string; proposalId: string }> }

/**
 * GET /api/collective-wallets/[id]/proposals/[proposalId]/signatures
 * Audit trail of a proposal's signatures in signing order, each with the
 * signer's weight and the running total toward the wallet threshold.
 * Only wallet signers may view it.
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
        signatures: {
          select: { id: true, signerId: true, createdAt: true, signer: { select: SIGNER_USER_SELECT } },
          orderBy: { createdAt: 'asc' },
        },
      },
    })
    if (!proposal) return NextResponse.json({ error: 'Proposal not found' }, { status: 404 })

    const signerIds = proposal.signatures.map((signature) => signature.signerId)
    const walletSigners = signerIds.length
      ? await prisma.walletSigner.findMany({
          where: { walletId: id, userId: { in: signerIds } },
          select: { userId: true, weight: true },
        })
      : []
    const weightByUserId = new Map(walletSigners.map((signer) => [signer.userId, signer.weight]))
    const requiredThreshold = access.wallet.threshold

    let cumulativeWeight = 0
    const signatures = proposal.signatures.map((signature) => {
      // A signer removed from the wallet after signing no longer contributes weight.
      const weight = weightByUserId.get(signature.signerId) ?? 0
      cumulativeWeight += weight
      return {
        id: signature.id,
        signer: signature.signer,
        createdAt: signature.createdAt,
        weight,
        activeSigner: weightByUserId.has(signature.signerId),
        cumulativeWeight,
        thresholdMet: cumulativeWeight >= requiredThreshold,
      }
    })

    return NextResponse.json({
      proposalId: proposal.id,
      signatures,
      currentWeight: cumulativeWeight,
      requiredThreshold,
      thresholdMet: cumulativeWeight >= requiredThreshold,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/collective-wallets/[id]/proposals/[proposalId]/signatures error')
    return NextResponse.json({ error: 'Failed to fetch proposal signatures' }, { status: 500 })
  }
}
