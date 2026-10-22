import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { debitDelegatedUSDC } from '@/lib/stellar'
import {
  BATCH_STATUS,
  ITEM_STATUS,
  NON_TERMINAL_ITEM_STATUSES,
  resolvePayoutBatchActor,
} from '../../_lib/payout-batches'

type RouteContext = { params: Promise<{ id: string }> }

async function sendPayout(fromAddress: string, toAddress: string, amount: string, itemId: string) {
  const delegateSecretKey = process.env.WITHDRAWAL_DELEGATE_SECRET_KEY
  if (!delegateSecretKey) {
    throw new Error('Payout delegate signer is not configured')
  }
  return debitDelegatedUSDC(delegateSecretKey, fromAddress, toAddress, amount, `payout:${itemId.slice(0, 20)}`)
}

interface ItemResult {
  itemId: string
  recipientIdentifier: string
  amount: string
  status: typeof ITEM_STATUS.success | typeof ITEM_STATUS.failed
  txHash?: string | null
  errorMessage?: string | null
  processedAt: string
}

/**
 * POST /api/payout-batches/[id]/execute
 *
 * Executes a payout batch by sending funds for all pending items in the batch.
 * - Guards against double-execution if the batch is already completed or currently executing.
 * - Processes items independently so that failure of one item does not abort remaining items.
 * - Increments successCount and failedCount independently.
 * - Appends structured outcome entries to the batch results JSON array.
 * - Updates batch status to completed once all items reach a terminal status.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const auth = await resolvePayoutBatchActor(request)
    if ('response' in auth) return auth.response
    const { actor } = auth

    const { id } = await context.params
    if (!id || id.trim() === '') {
      return NextResponse.json({ error: 'Payout batch ID is required' }, { status: 400 })
    }

    const batch = await prisma.payoutBatch.findFirst({
      where: { id, userId: actor.id },
    })
    if (!batch) {
      return NextResponse.json({ error: 'Payout batch not found' }, { status: 404 })
    }

    if (batch.status === BATCH_STATUS.completed || batch.completedAt) {
      return NextResponse.json({ error: 'Payout batch is already completed' }, { status: 409 })
    }
    if (batch.status === BATCH_STATUS.processing) {
      return NextResponse.json({ error: 'Payout batch is currently executing' }, { status: 409 })
    }
    if (batch.status === BATCH_STATUS.cancelled || batch.cancelledAt) {
      return NextResponse.json({ error: 'Payout batch is cancelled' }, { status: 409 })
    }

    const pendingItems = await prisma.payoutItem.findMany({
      where: { batchId: id, status: ITEM_STATUS.pending },
      orderBy: { createdAt: 'asc' },
    })

    if (pendingItems.length === 0) {
      return NextResponse.json({ error: 'No pending items to execute in this batch' }, { status: 400 })
    }

    const wallet = await prisma.wallet.findUnique({
      where: { userId: actor.id },
      select: { address: true },
    })
    if (!wallet) {
      return NextResponse.json({ error: 'No wallet found for this account' }, { status: 400 })
    }

    // Atomically transition status to processing to guard against concurrent double-execution
    const claim = await prisma.payoutBatch.updateMany({
      where: {
        id,
        userId: actor.id,
        status: { notIn: [BATCH_STATUS.completed, BATCH_STATUS.processing, BATCH_STATUS.cancelled] },
        completedAt: null,
        cancelledAt: null,
      },
      data: { status: BATCH_STATUS.processing },
    })
    if (claim.count === 0) {
      return NextResponse.json({ error: 'Payout batch is currently executing or already finished' }, { status: 409 })
    }

    let newSuccesses = 0
    let newFailures = 0
    const itemResults: ItemResult[] = []

    for (const item of pendingItems) {
      const processedAt = new Date().toISOString()
      const amountStr = item.amount.toString()

      if (item.payoutType !== 'stellar') {
        const errorMsg = `Unsupported payout type '${item.payoutType}'`
        await prisma.payoutItem.update({
          where: { id: item.id },
          data: { status: ITEM_STATUS.failed, errorMessage: errorMsg },
        })
        newFailures++
        itemResults.push({
          itemId: item.id,
          recipientIdentifier: item.recipientIdentifier,
          amount: amountStr,
          status: ITEM_STATUS.failed,
          errorMessage: errorMsg,
          processedAt,
        })
        continue
      }

      try {
        const txHash = await sendPayout(wallet.address, item.recipientIdentifier, amountStr, item.id)
        await prisma.payoutItem.update({
          where: { id: item.id },
          data: { status: ITEM_STATUS.success, txHash, errorMessage: null },
        })
        newSuccesses++
        itemResults.push({
          itemId: item.id,
          recipientIdentifier: item.recipientIdentifier,
          amount: amountStr,
          status: ITEM_STATUS.success,
          txHash,
          processedAt,
        })
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : 'Payout failed'
        logger.warn({ batchId: id, itemId: item.id, err }, 'Payout item execution failed')
        await prisma.payoutItem.update({
          where: { id: item.id },
          data: { status: ITEM_STATUS.failed, errorMessage: errorMsg },
        })
        newFailures++
        itemResults.push({
          itemId: item.id,
          recipientIdentifier: item.recipientIdentifier,
          amount: amountStr,
          status: ITEM_STATUS.failed,
          errorMessage: errorMsg,
          processedAt,
        })
      }
    }

    const remainingItems = await prisma.payoutItem.count({
      where: { batchId: id, status: { in: NON_TERMINAL_ITEM_STATUSES } },
    })

    const existingResults = Array.isArray(batch.results) ? (batch.results as unknown as ItemResult[]) : []
    const updatedResults = [...existingResults, ...itemResults]

    const isFullyCompleted = remainingItems === 0
    const finalStatus = isFullyCompleted ? BATCH_STATUS.completed : BATCH_STATUS.processing
    const finalCompletedAt = isFullyCompleted ? new Date() : null

    const updatedBatch = await prisma.payoutBatch.update({
      where: { id },
      data: {
        status: finalStatus,
        completedAt: finalCompletedAt,
        successCount: { increment: newSuccesses },
        failedCount: { increment: newFailures },
        results: updatedResults,
      },
    })

    logger.info(
      { batchId: id, successes: newSuccesses, failures: newFailures, finalStatus },
      'Payout batch execution finished',
    )

    return NextResponse.json({
      batch: updatedBatch,
      processedCount: pendingItems.length,
      successCount: newSuccesses,
      failedCount: newFailures,
      results: itemResults,
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/payout-batches/[id]/execute error')
    return NextResponse.json({ error: 'Failed to execute payout batch' }, { status: 500 })
  }
}
