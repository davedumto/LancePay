import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import {
  SIGNER_USER_SELECT,
  requireWalletActor,
  requireWalletSigner,
} from '@/app/api/_lib/collective-wallet-auth'

type RouteContext = { params: Promise<{ id: string }> }

const PROPOSAL_SELECT = {
  id: true,
  walletId: true,
  destinationAddress: true,
  amountUsdc: true,
  memo: true,
  status: true,
  expiresAt: true,
  executedAt: true,
  stellarTxHash: true,
  createdAt: true,
  proposer: { select: SIGNER_USER_SELECT },
  signatures: { select: { signerId: true } },
} as const

/**
 * GET /api/collective-wallets/[id]/proposals/pending
 * List pending proposals awaiting the authenticated caller's signature.
 * Excludes proposals already signed by the caller, expired, or executed.
 * Sorted by expiresAt ascending.
 */
export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const auth = await requireWalletActor(request)
    if ('response' in auth) return auth.response

    const { id } = await params
    const access = await requireWalletSigner(id, auth.actor.id)
    if ('response' in access) return access.response
    const { wallet } = access

    const [signers, proposals] = await Promise.all([
      prisma.walletSigner.findMany({
        where: { walletId: id },
        select: { userId: true, weight: true },
      }),
      prisma.multisigProposal.findMany({
        where: {
          walletId: id,
          status: { notIn: ['executed', 'cancelled'] },
          expiresAt: { gt: new Date() },
          signatures: {
            none: { signerId: auth.actor.id },
          },
        },
        select: PROPOSAL_SELECT,
        orderBy: { expiresAt: 'asc' },
      }),
    ])

    const weightMap = new Map(signers.map((s) => [s.userId, s.weight]))

    const proposalsWithWeights = proposals.map(({ signatures, ...proposal }) => {
      const currentSignatureWeight = signatures.reduce(
        (sum, sig) => sum + (weightMap.get(sig.signerId) ?? 1),
        0
      )
      return {
        ...proposal,
        currentSignatureWeight,
        currentWeight: currentSignatureWeight,
        threshold: wallet.threshold,
        signaturesCount: signatures.length,
      }
    })

    return NextResponse.json({
      proposals: proposalsWithWeights,
      threshold: wallet.threshold,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/collective-wallets/[id]/proposals/pending error')
    return NextResponse.json({ error: 'Failed to fetch pending proposals' }, { status: 500 })
  }
}
