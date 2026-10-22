import { NextRequest, NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { debitDelegatedUSDC } from '@/lib/stellar'
import {
  BATCH_STATUS,
  ITEM_STATUS,
  NON_TERMINAL_ITEM_STATUSES,
  resolvePayoutBatchActor,
} from '../../../../_lib/payout-batches'

// POST /api/payout-batches/[id]/items/[itemId]/retry
//
// Re-sends a single `failed` PayoutItem without re-running the rest of the
// batch. Only the batch owner can retry, and only items in `failed` status.
//
// The item is first claimed by moving it `failed` -> `processing` with a
// conditional update, so two concurrent retries of the same item cannot both
// send funds: the loser gets 409. The payout is then sent from the owner's
// wallet via the platform's delegated signer (same path as withdrawals).
//
//   - success: item -> `success` with the new txHash; in one transaction the
//     batch failedCount is decremented and successCount incremented, then the
//     batch's completion is recomputed from the item rows — it stays (or
//     becomes) `completed` only when no pending/processing items remain.
//   - failure: item goes back to `failed` with the new error message and the
//     batch counters are left unchanged; responds 502.
//
// Cancelled batches cannot be retried. Only `stellar` payouts (where
// recipientIdentifier is a Stellar address) can be sent from here.

type RouteContext = { params: Promise<{ id: string; itemId: string }> }

const SUPPORTED_PAYOUT_TYPES = new Set(['stellar'])

async function sendPayout(fromAddress: string, toAddress: string, amount: string, itemId: string) {
  const delegateSecretKey = process.env.WITHDRAWAL_DELEGATE_SECRET_KEY
  if (!delegateSecretKey) {
    throw new Error('Payout delegate signer is not configured')
  }
  return debitDelegatedUSDC(delegateSecretKey, fromAddress, toAddress, amount, `payout:${itemId.slice(0, 20)}`)
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const auth = await resolvePayoutBatchActor(request)
    if ('response' in auth) return auth.response
    const { actor } = auth

    const { id, itemId } = await context.params
    if (!id || id.trim() === '' || !itemId || itemId.trim() === '') {
      return NextResponse.json({ error: 'Payout batch ID and item ID are required' }, { status: 400 })
    }

    const batch = await prisma.payoutBatch.findFirst({ where: { id, userId: actor.id } })
    if (!batch) {
      return NextResponse.json({ error: 'Payout batch not found' }, { status: 404 })
    }
    if (batch.status === BATCH_STATUS.cancelled || batch.cancelledAt) {
      return NextResponse.json({ error: 'Items in a cancelled payout batch cannot be retried' }, { status: 409 })
    }

    const item = await prisma.payoutItem.findFirst({ where: { id: itemId, batchId: id } })
    if (!item) {
      return NextResponse.json({ error: 'Payout item not found' }, { status: 404 })
    }
    if (item.status !== ITEM_STATUS.failed) {
      return NextResponse.json(
        { error: `Payout item in status '${item.status}' cannot be retried`, retryableStatus: ITEM_STATUS.failed },
        { status: 409 },
      )
    }
    if (!SUPPORTED_PAYOUT_TYPES.has(item.payoutType)) {
      return NextResponse.json(
        { error: `Retry is not supported for payout type '${item.payoutType}'` },
        { status: 422 },
      )
    }

    const wallet = await prisma.wallet.findUnique({ where: { userId: actor.id }, select: { address: true } })
    if (!wallet) {
      return NextResponse.json({ error: 'No wallet found for this account' }, { status: 400 })
    }

    const claimed = await prisma.payoutItem.updateMany({
      where: { id: itemId, batchId: id, status: ITEM_STATUS.failed },
      data: { status: ITEM_STATUS.processing },
    })
    if (claimed.count === 0) {
      return NextResponse.json({ error: 'Payout item is already being retried' }, { status: 409 })
    }

    let txHash: string
    try {
      txHash = await sendPayout(wallet.address, item.recipientIdentifier, item.amount.toString(), itemId)
    } catch (error: any) {
      const errorMessage = error?.message || 'Payout failed'
      await prisma.payoutItem.update({
        where: { id: itemId },
        data: { status: ITEM_STATUS.failed, errorMessage },
      })
      logger.warn({ batchId: id, itemId, err: error }, 'Payout item retry failed')
      return NextResponse.json(
        { error: 'Payout retry failed', item: { id: itemId, status: ITEM_STATUS.failed, errorMessage } },
        { status: 502 },
      )
    }

    // Funds have moved at this point. If recording the outcome fails, the item
    // is left in `processing` (never retryable again) and the txHash is logged
    // so it can be settled by hand rather than paid twice.
    let result
    try {
      result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const updatedItem = await tx.payoutItem.update({
          where: { id: itemId },
          data: { status: ITEM_STATUS.success, txHash, errorMessage: null },
        })

        // Decrement failedCount only while it is positive so drifted counters
        // never go negative; GET /reconciliation surfaces any such drift.
        const decremented = await tx.payoutBatch.updateMany({
          where: { id, failedCount: { gt: 0 } },
          data: { failedCount: { decrement: 1 }, successCount: { increment: 1 } },
        })
        if (decremented.count === 0) {
          logger.warn({ batchId: id, itemId }, 'Payout batch failedCount was already 0 during retry')
          await tx.payoutBatch.update({
            where: { id },
            data: { successCount: { increment: 1 } },
          })
        }

        const remaining = await tx.payoutItem.count({
          where: { batchId: id, status: { in: NON_TERMINAL_ITEM_STATUSES } },
        })
        const current = await tx.payoutBatch.findUniqueOrThrow({ where: { id } })
        const completion =
          remaining === 0
            ? { status: BATCH_STATUS.completed, completedAt: current.completedAt ?? new Date() }
            : {
                status: current.status === BATCH_STATUS.completed ? BATCH_STATUS.processing : current.status,
                completedAt: null,
              }

        const updatedBatch = await tx.payoutBatch.update({ where: { id }, data: completion })
        return { updatedItem, updatedBatch }
      })
    } catch (error) {
      logger.error({ batchId: id, itemId, txHash, err: error }, 'Payout sent but recording the retry outcome failed')
      return NextResponse.json(
        { error: 'Payout was sent but its outcome could not be recorded', txHash },
        { status: 500 },
      )
    }

    logger.info({ batchId: id, itemId, txHash }, 'Payout item retried successfully')

    return NextResponse.json({
      item: {
        id: result.updatedItem.id,
        status: result.updatedItem.status,
        txHash: result.updatedItem.txHash,
        amount: result.updatedItem.amount.toString(),
        recipientIdentifier: result.updatedItem.recipientIdentifier,
      },
      batch: {
        id: result.updatedBatch.id,
        status: result.updatedBatch.status,
        successCount: result.updatedBatch.successCount,
        failedCount: result.updatedBatch.failedCount,
        completedAt: result.updatedBatch.completedAt,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/payout-batches/[id]/items/[itemId]/retry error')
    return NextResponse.json({ error: 'Failed to retry payout item' }, { status: 500 })
  }
}
