import { NextRequest, NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { BATCH_STATUS, ITEM_STATUS, resolvePayoutBatchActor } from '../../_lib/payout-batches'

// POST /api/payout-batches/[id]/cancel
//
// Body: { reason: string (1–500 chars) }
//
// Moves every item still in `pending` to `cancelled` and marks the batch
// `cancelled`, recording cancelledAt, cancellationReason and cancelledById for
// audit. Items already in `success` or `failed` (or mid-retry in `processing`)
// are never touched, and the batch's success/failed counters are left as-is.
//
// Rejected with 409 when the batch is already completed or cancelled, or when
// it has no pending items left to stop. The pending-item update and the batch
// update run in one transaction, and the batch update is conditional on it
// not having been completed/cancelled concurrently.

const cancelSchema = z.object({
  reason: z.string().trim().min(1, 'reason is required').max(500),
})

type RouteContext = { params: Promise<{ id: string }> }

class CancelConflict extends Error {}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const auth = await resolvePayoutBatchActor(request)
    if ('response' in auth) return auth.response
    const { actor } = auth

    const { id } = await context.params
    if (!id || id.trim() === '') {
      return NextResponse.json({ error: 'Payout batch ID is required' }, { status: 400 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = cancelSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      )
    }
    const { reason } = parsed.data

    const batch = await prisma.payoutBatch.findFirst({ where: { id, userId: actor.id } })
    if (!batch) {
      return NextResponse.json({ error: 'Payout batch not found' }, { status: 404 })
    }

    if (batch.status === BATCH_STATUS.cancelled || batch.cancelledAt) {
      return NextResponse.json({ error: 'Payout batch is already cancelled' }, { status: 409 })
    }
    if (batch.status === BATCH_STATUS.completed || batch.completedAt) {
      return NextResponse.json({ error: 'Payout batch is already completed' }, { status: 409 })
    }

    const cancelledAt = new Date()
    let result
    try {
      result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const items = await tx.payoutItem.updateMany({
          where: { batchId: id, status: ITEM_STATUS.pending },
          data: { status: ITEM_STATUS.cancelled },
        })
        if (items.count === 0) {
          throw new CancelConflict('Payout batch has no pending items to cancel')
        }

        const updated = await tx.payoutBatch.updateMany({
          where: {
            id,
            userId: actor.id,
            completedAt: null,
            cancelledAt: null,
            status: { notIn: [BATCH_STATUS.completed, BATCH_STATUS.cancelled] },
          },
          data: {
            status: BATCH_STATUS.cancelled,
            cancelledAt,
            cancellationReason: reason,
            cancelledById: actor.id,
          },
        })
        if (updated.count === 0) {
          throw new CancelConflict('Payout batch was completed or cancelled concurrently')
        }

        return { cancelledItemCount: items.count }
      })
    } catch (error) {
      if (error instanceof CancelConflict) {
        return NextResponse.json({ error: error.message }, { status: 409 })
      }
      throw error
    }

    logger.info(
      { batchId: id, userId: actor.id, cancelledItemCount: result.cancelledItemCount },
      'Payout batch cancelled',
    )

    return NextResponse.json({
      batch: {
        id: batch.id,
        status: BATCH_STATUS.cancelled,
        totalRecipients: batch.totalRecipients,
        successCount: batch.successCount,
        failedCount: batch.failedCount,
        cancelledAt,
        cancellationReason: reason,
        cancelledById: actor.id,
      },
      cancelledItemCount: result.cancelledItemCount,
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/payout-batches/[id]/cancel error')
    return NextResponse.json({ error: 'Failed to cancel payout batch' }, { status: 500 })
  }
}
