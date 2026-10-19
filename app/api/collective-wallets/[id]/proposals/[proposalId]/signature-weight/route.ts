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
      select: { id: true, signatures: { select: { signerId: true } } },
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

    return NextResponse.json({
      proposalId: proposal.id,
      currentWeight,
      requiredThreshold,
      thresholdMet: currentWeight >= requiredThreshold,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/collective-wallets/[id]/proposals/[proposalId]/signature-weight error')
    return NextResponse.json({ error: 'Failed to calculate signature weight' }, { status: 500 })
  }
}