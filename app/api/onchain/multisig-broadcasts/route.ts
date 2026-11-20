import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { decrypt } from '@/lib/crypto'
import { submitMultisigPaymentWithRetry } from '@/lib/stellar'

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const actor = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!actor) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const body = await request.json().catch(() => ({}))
    const { proposalId } = body

    if (!proposalId || typeof proposalId !== 'string' || proposalId.trim().length === 0) {
      return NextResponse.json({ error: 'proposalId is required' }, { status: 400 })
    }

    const proposal = await prisma.multisigProposal.findUnique({
      where: { id: proposalId },
      include: { wallet: true, signatures: true },
    })
    if (!proposal) {
      return NextResponse.json({ error: 'Proposal not found' }, { status: 404 })
    }

    const isSigner = await prisma.walletSigner.findUnique({
      where: { walletId_userId: { walletId: proposal.walletId, userId: actor.id } },
    })
    if (!isSigner) {
      return NextResponse.json(
        { error: 'Forbidden: only wallet signers can broadcast a proposal' },
        { status: 403 },
      )
    }

    if (proposal.status === 'executed') {
      return NextResponse.json(
        {
          message: 'Proposal already broadcast',
          proposalId: proposal.id,
          stellarTxHash: proposal.stellarTxHash,
          status: proposal.status,
        },
        { status: 200 },
      )
    }

    if (proposal.status !== 'pending') {
      return NextResponse.json(
        { error: `Proposal cannot be broadcast from status "${proposal.status}"` },
        { status: 400 },
      )
    }

    if (proposal.expiresAt.getTime() <= Date.now()) {
      return NextResponse.json({ error: 'Proposal has expired' }, { status: 400 })
    }

    if (proposal.signatures.length < proposal.wallet.threshold) {
      return NextResponse.json(
        {
          error: `Proposal requires ${proposal.wallet.threshold} signatures, has ${proposal.signatures.length}`,
        },
        { status: 400 },
      )
    }

    if (!proposal.wallet.encryptedSecretKey) {
      return NextResponse.json(
        { error: 'Collective wallet has no signing key configured' },
        { status: 400 },
      )
    }

    // Atomically claim execution so two concurrent broadcast requests for the
    // same proposal cannot both submit a transaction to the network.
    const claim = await prisma.multisigProposal.updateMany({
      where: { id: proposal.id, status: 'pending' },
      data: { status: 'executing', executionStartedAt: new Date() },
    })
    if (claim.count === 0) {
      return NextResponse.json(
        { error: 'Proposal is already being broadcast' },
        { status: 409 },
      )
    }

    let stellarTxHash: string
    try {
      const sourceSecretKey = decrypt(proposal.wallet.encryptedSecretKey)
      stellarTxHash = (await submitMultisigPaymentWithRetry(
        sourceSecretKey,
        proposal.destinationAddress,
        proposal.amountUsdc.toString(),
        proposal.memo ?? undefined,
      )).hash
    } catch (error: any) {
      const message = error?.message || 'Failed to broadcast multisig transaction'

      // Release the claim so the proposal can be retried instead of getting
      // stuck in "executing" forever.
      await prisma.multisigProposal.update({
        where: { id: proposal.id },
        data: { status: 'pending', lastError: message },
      })

      logger.error(
        { err: error, proposalId: proposal.id, walletId: proposal.walletId },
        'Multisig broadcast failed',
      )
      return NextResponse.json({ error: message }, { status: 502 })
    }

    const executed = await prisma.multisigProposal.update({
      where: { id: proposal.id },
      data: {
        status: 'executed',
        stellarTxHash,
        executedAt: new Date(),
        lastError: null,
      },
    })

    logger.info(
      { proposalId: proposal.id, walletId: proposal.walletId, stellarTxHash },
      'Multisig proposal broadcast successfully',
    )

    return NextResponse.json(
      {
        message: 'Proposal broadcast successfully',
        proposalId: executed.id,
        stellarTxHash: executed.stellarTxHash,
        status: executed.status,
        executedAt: executed.executedAt,
      },
      { status: 200 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/onchain/multisig-broadcasts error')
    return NextResponse.json({ error: 'Failed to broadcast multisig proposal' }, { status: 500 })
  }
}
