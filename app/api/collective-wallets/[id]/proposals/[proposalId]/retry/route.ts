import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { decrypt } from '@/lib/crypto'
import { submitMultisigPaymentWithRetry } from '@/lib/stellar'
import { requireWalletActor, requireWalletSigner } from '@/app/api/_lib/collective-wallet-auth'

type RouteContext = { params: Promise<{ id: string; proposalId: string }> }

export const MAX_RETRY_ATTEMPTS = 3

/**
 * POST /api/collective-wallets/[id]/proposals/[proposalId]/retry
 * Retry a proposal that reached threshold but failed on-chain execution.
 *
 * Rules:
 * - Only allow retry when status reflects failed execution with lastError populated and stellarTxHash empty.
 * - Cap retry attempts and surface a permanent-failure state once exceeded.
 * - Clear lastError optimistically but restore it if the retry also fails, keeping executionStartedAt consistent.
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
      include: { wallet: true, signatures: true },
    })

    if (!proposal) {
      return NextResponse.json(
        { error: 'Proposal not found', code: 'PROPOSAL_NOT_FOUND' },
        { status: 404 }
      )
    }

    if (
      proposal.status === 'executed' ||
      (proposal.stellarTxHash && proposal.stellarTxHash.trim().length > 0)
    ) {
      return NextResponse.json(
        { error: 'Proposal has already been executed', code: 'ALREADY_EXECUTED' },
        { status: 400 }
      )
    }

    if (
      proposal.status === 'permanently_failed' ||
      proposal.status === 'permanent_failure'
    ) {
      return NextResponse.json(
        {
          error: 'Proposal has permanently failed and cannot be retried',
          code: 'PERMANENT_FAILURE',
          status: 'permanently_failed',
        },
        { status: 400 }
      )
    }

    if (!proposal.lastError || proposal.lastError.trim().length === 0) {
      return NextResponse.json(
        {
          error: 'Proposal is not in a failed execution state (lastError is not populated)',
          code: 'NOT_FAILED',
        },
        { status: 400 }
      )
    }

    if (proposal.expiresAt.getTime() <= Date.now()) {
      return NextResponse.json(
        { error: 'Proposal has expired and cannot be retried', code: 'PROPOSAL_EXPIRED' },
        { status: 400 }
      )
    }

    if (proposal.signatures.length < proposal.wallet.threshold) {
      return NextResponse.json(
        {
          error: `Proposal requires ${proposal.wallet.threshold} signatures, but only has ${proposal.signatures.length}`,
          code: 'THRESHOLD_NOT_MET',
        },
        { status: 400 }
      )
    }

    if (proposal.status === 'executing') {
      return NextResponse.json(
        { error: 'Proposal execution is currently in progress', code: 'ALREADY_EXECUTING' },
        { status: 409 }
      )
    }

    if (!proposal.wallet.encryptedSecretKey) {
      return NextResponse.json(
        { error: 'Collective wallet has no signing key configured', code: 'NO_SIGNING_KEY' },
        { status: 400 }
      )
    }

    const attemptMatch =
      proposal.lastError.match(/\[attempt\s*(\d+)\]/i) ||
      proposal.lastError.match(/attempt\s*(\d+)/i)
    const currentAttempt = attemptMatch ? parseInt(attemptMatch[1], 10) : 1

    if (currentAttempt >= MAX_RETRY_ATTEMPTS) {
      await prisma.multisigProposal.update({
        where: { id: proposal.id },
        data: { status: 'permanently_failed' },
      })
      return NextResponse.json(
        {
          error: `Max retry attempts (${MAX_RETRY_ATTEMPTS}) exceeded. Proposal permanently failed.`,
          code: 'PERMANENT_FAILURE',
          status: 'permanently_failed',
          attempts: currentAttempt,
        },
        { status: 400 }
      )
    }

    const executionStartedAt = proposal.executionStartedAt ?? new Date()

    // Optimistically clear lastError and transition to executing
    await prisma.multisigProposal.update({
      where: { id: proposal.id },
      data: {
        status: 'executing',
        lastError: null,
        executionStartedAt,
      },
    })

    let stellarTxHash: string
    try {
      const sourceSecretKey = decrypt(proposal.wallet.encryptedSecretKey)
      stellarTxHash = await submitMultisigPaymentWithRetry(
        sourceSecretKey,
        proposal.destinationAddress,
        proposal.amountUsdc.toString(),
        proposal.memo ?? undefined
      )
    } catch (broadcastError: unknown) {
      const errorMessage =
        broadcastError instanceof Error
          ? broadcastError.message
          : typeof broadcastError === 'object' && broadcastError !== null && 'message' in broadcastError
            ? String((broadcastError as { message: unknown }).message)
            : 'Failed to broadcast multisig transaction'
      const nextAttempt = currentAttempt + 1
      const isExceeded = nextAttempt >= MAX_RETRY_ATTEMPTS
      const failureStatus = isExceeded ? 'permanently_failed' : 'failed'
      const restoredError = `[attempt ${nextAttempt}] ${errorMessage}`

      await prisma.multisigProposal.update({
        where: { id: proposal.id },
        data: {
          status: failureStatus,
          lastError: restoredError,
          executionStartedAt, // kept consistent!
        },
      })

      logger.error(
        { err: broadcastError, proposalId: proposal.id, walletId: id, attempt: nextAttempt },
        'Multisig retry broadcast failed'
      )

      return NextResponse.json(
        {
          error: errorMessage,
          status: failureStatus,
          code: isExceeded ? 'PERMANENT_FAILURE' : 'RETRY_FAILED',
          attempts: nextAttempt,
          lastError: restoredError,
        },
        { status: 502 }
      )
    }

    const executed = await prisma.multisigProposal.update({
      where: { id: proposal.id },
      data: {
        status: 'executed',
        stellarTxHash,
        executedAt: new Date(),
        lastError: null,
        executionStartedAt, // kept consistent!
      },
    })

    logger.info(
      { proposalId: proposal.id, walletId: id, stellarTxHash },
      'Multisig proposal retried and executed successfully'
    )

    return NextResponse.json(
      {
        message: 'Proposal retried and broadcast successfully',
        proposalId: executed.id,
        stellarTxHash: executed.stellarTxHash,
        status: executed.status,
        executedAt: executed.executedAt,
      },
      { status: 200 }
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/collective-wallets/[id]/proposals/[proposalId]/retry error')
    return NextResponse.json(
      { error: 'Failed to retry proposal execution' },
      { status: 500 }
    )
  }
}
