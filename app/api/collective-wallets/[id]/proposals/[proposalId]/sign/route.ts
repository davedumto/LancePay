import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { decrypt } from '@/lib/crypto'
import { submitMultisigPaymentWithRetry } from '@/lib/stellar'
import {
  isUniqueConstraintError,
  requireWalletActor,
  requireWalletSigner,
} from '@/app/api/_lib/collective-wallet-auth'

type RouteContext = { params: Promise<{ id: string; proposalId: string }> }

/**
 * POST /api/collective-wallets/[id]/proposals/[proposalId]/sign
 * Records the caller's signature on a pending proposal. When cumulative signer
 * weight reaches the wallet threshold the proposal is claimed for execution
 * (pending -> executing) and submitted to the network.
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
      select: {
        id: true,
        status: true,
        expiresAt: true,
        destinationAddress: true,
        amountUsdc: true,
        memo: true,
        wallet: { select: { encryptedSecretKey: true } },
      },
    })
    if (!proposal) return NextResponse.json({ error: 'Proposal not found' }, { status: 404 })

    if (proposal.status === 'executing' || proposal.status === 'executed') {
      return NextResponse.json(
        { error: 'Proposal has already been executed', code: 'ALREADY_EXECUTED' },
        { status: 409 }
      )
    }
    if (proposal.status !== 'pending') {
      return NextResponse.json(
        { error: `Proposal cannot be signed from status "${proposal.status}"` },
        { status: 409 }
      )
    }
    if (proposal.expiresAt.getTime() <= Date.now()) {
      return NextResponse.json({ error: 'Proposal has expired', code: 'PROPOSAL_EXPIRED' }, { status: 400 })
    }

    let signature
    try {
      signature = await prisma.proposalSignature.create({
        data: { proposalId: proposal.id, signerId: auth.actor.id },
        select: { id: true, signerId: true, createdAt: true },
      })
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return NextResponse.json(
          { error: 'You have already signed this proposal', code: 'ALREADY_SIGNED' },
          { status: 409 }
        )
      }
      throw error
    }

    const signatures = await prisma.proposalSignature.findMany({
      where: { proposalId: proposal.id },
      select: { signerId: true },
    })
    const signers = await prisma.walletSigner.findMany({
      where: { walletId: id, userId: { in: signatures.map((s) => s.signerId) } },
      select: { weight: true },
    })
    const currentWeight = signers.reduce((total, signer) => total + signer.weight, 0)
    const requiredThreshold = access.wallet.threshold
    const thresholdMet = currentWeight >= requiredThreshold

    const respond = (
      execution: { status: string; stellarTxHash?: string | null; lastError?: string | null }
    ) =>
      NextResponse.json(
        {
          signature,
          proposalId: proposal.id,
          currentWeight,
          requiredThreshold,
          thresholdMet,
          status: execution.status,
          stellarTxHash: execution.stellarTxHash ?? null,
          lastError: execution.lastError ?? null,
        },
        { status: 201 }
      )

    if (!thresholdMet) return respond({ status: 'pending' })

    const encryptedSecretKey = proposal.wallet.encryptedSecretKey
    if (!encryptedSecretKey) {
      return respond({ status: 'pending', lastError: 'Collective wallet has no signing key configured' })
    }

    // Atomically claim execution: when two signers cross the threshold at the
    // same time only one updateMany matches status "pending", so the payment is
    // submitted exactly once.
    const claim = await prisma.multisigProposal.updateMany({
      where: { id: proposal.id, status: 'pending', expiresAt: { gt: new Date() } },
      data: { status: 'executing', executionStartedAt: new Date() },
    })
    if (claim.count === 0) return respond({ status: 'executing' })

    let stellarTxHash: string
    try {
      stellarTxHash = await submitMultisigPaymentWithRetry(
        decrypt(encryptedSecretKey),
        proposal.destinationAddress,
        proposal.amountUsdc.toString(),
        proposal.memo ?? undefined
      )
    } catch (error: any) {
      const message = error?.message || 'Failed to broadcast multisig transaction'

      // Release the claim so the proposal can be retried via broadcast instead
      // of getting stuck in "executing".
      await prisma.multisigProposal.update({
        where: { id: proposal.id },
        data: { status: 'pending', lastError: message },
      })
      logger.error(
        { err: error, proposalId: proposal.id, walletId: id },
        'Multisig execution after threshold failed'
      )
      return respond({ status: 'pending', lastError: message })
    }

    await prisma.multisigProposal.update({
      where: { id: proposal.id },
      data: { status: 'executed', stellarTxHash, executedAt: new Date(), lastError: null },
    })

    logger.info(
      { walletId: id, proposalId: proposal.id, stellarTxHash },
      'Multisig proposal executed after reaching threshold'
    )

    return respond({ status: 'executed', stellarTxHash })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/collective-wallets/[id]/proposals/[proposalId]/sign error')
    return NextResponse.json({ error: 'Failed to sign proposal' }, { status: 500 })
  }
}
