import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { requireWalletActor, requireWalletSigner } from '@/app/api/_lib/collective-wallet-auth'

type RouteContext = { params: Promise<{ id: string; signerId: string }> }

type RemovalResult =
  | { ok: true; removed: { id: string; userId: string }; remainingWeight: number; remainingSigners: number }
  | { ok: false; status: number; body: Record<string, unknown> }

/**
 * DELETE /api/collective-wallets/[id]/signers/[signerId]
 * Remove a signer (by WalletSigner id). Only signers of the wallet may remove signers.
 *
 * Quorum: the remaining signers must still be able to reach the threshold, both
 * by total weight and by head count (multisig broadcast counts one signature per
 * signer against the threshold).
 *
 * Pending proposals: removal is rejected while the signer is the proposer of a
 * live pending proposal. Allowing it would orphan the proposal — it would stay
 * pending under a proposer who is no longer a signer and could still gather
 * signatures and execute. Callers must let those proposals execute, expire, or
 * be cancelled first.
 */
export async function DELETE(request: NextRequest, { params }: RouteContext) {
  try {
    const auth = await requireWalletActor(request)
    if ('response' in auth) return auth.response

    const { id, signerId } = await params
    const access = await requireWalletSigner(id, auth.actor.id)
    if ('response' in access) return access.response
    const { wallet } = access

    // Serializable so two concurrent removals cannot both pass the quorum check.
    const result = await prisma.$transaction(
      async (tx): Promise<RemovalResult> => {
        const signer = await tx.walletSigner.findFirst({
          where: { id: signerId, walletId: wallet.id },
          select: { id: true, userId: true, weight: true },
        })
        if (!signer) {
          return {
            ok: false,
            status: 404,
            body: { error: 'Signer not found on this wallet', code: 'SIGNER_NOT_FOUND' },
          }
        }

        const totals = await tx.walletSigner.aggregate({
          where: { walletId: wallet.id },
          _sum: { weight: true },
          _count: { _all: true },
        })
        const remainingWeight = (totals._sum.weight ?? 0) - signer.weight
        const remainingSigners = totals._count._all - 1

        if (remainingWeight < wallet.threshold || remainingSigners < wallet.threshold) {
          return {
            ok: false,
            status: 409,
            body: {
              error: 'Removing this signer would leave the wallet unable to reach its threshold',
              code: 'QUORUM_VIOLATION',
              details: { remainingWeight, remainingSigners, threshold: wallet.threshold },
            },
          }
        }

        const pendingProposals = await tx.multisigProposal.findMany({
          where: {
            walletId: wallet.id,
            proposerId: signer.userId,
            status: 'pending',
            expiresAt: { gt: new Date() },
          },
          select: { id: true },
        })
        if (pendingProposals.length > 0) {
          return {
            ok: false,
            status: 409,
            body: {
              error: 'Signer has pending proposals awaiting signatures; resolve them before removal',
              code: 'PENDING_PROPOSALS',
              details: { proposalIds: pendingProposals.map((p) => p.id) },
            },
          }
        }

        await tx.walletSigner.delete({ where: { id: signer.id } })
        return {
          ok: true,
          removed: { id: signer.id, userId: signer.userId },
          remainingWeight,
          remainingSigners,
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    )

    if (!result.ok) return NextResponse.json(result.body, { status: result.status })

    logger.info(
      { walletId: wallet.id, signerId: result.removed.id, removedBy: auth.actor.id },
      'Collective wallet signer removed'
    )

    return NextResponse.json({
      removed: result.removed,
      remainingWeight: result.remainingWeight,
      remainingSigners: result.remainingSigners,
      threshold: wallet.threshold,
    })
  } catch (error) {
    // Serialization failure from a concurrent signer change — safe for the client to retry.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
      return NextResponse.json(
        { error: 'Wallet signers changed concurrently; please retry', code: 'CONFLICT' },
        { status: 409 }
      )
    }
    logger.error({ err: error }, 'DELETE /api/collective-wallets/[id]/signers/[signerId] error')
    return NextResponse.json({ error: 'Failed to remove wallet signer' }, { status: 500 })
  }
}
