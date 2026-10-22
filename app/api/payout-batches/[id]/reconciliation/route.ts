import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { ITEM_STATUS, isAdmin, resolvePayoutBatchActor } from '../../_lib/payout-batches'

// GET /api/payout-batches/[id]/reconciliation
//
// Recomputes successCount, failedCount, totalAmount and totalRecipients from
// the batch's PayoutItem rows and compares them with the counters stored on
// the PayoutBatch. Any drift is reported in `mismatches`; nothing is written,
// so a mismatch stays visible until someone investigates it.
//
// Visible to the batch owner or an admin. Batches belonging to other users
// return 404 (not 403) so their existence is not leaked.

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const auth = await resolvePayoutBatchActor(request)
    if ('response' in auth) return auth.response
    const { actor } = auth

    const { id } = await context.params
    if (!id || id.trim() === '') {
      return NextResponse.json({ error: 'Payout batch ID is required' }, { status: 400 })
    }

    const batch = await prisma.payoutBatch.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        status: true,
        totalAmount: true,
        totalRecipients: true,
        successCount: true,
        failedCount: true,
      },
    })
    if (!batch || (batch.userId !== actor.id && !isAdmin(actor))) {
      return NextResponse.json({ error: 'Payout batch not found' }, { status: 404 })
    }

    const itemsByStatus = await prisma.payoutItem.groupBy({
      by: ['status'],
      where: { batchId: id },
      _count: { _all: true },
      _sum: { amount: true },
    })

    let itemCount = 0
    let itemTotalAmount = new Prisma.Decimal(0)
    const itemCountByStatus: Record<string, number> = {}
    for (const row of itemsByStatus) {
      itemCountByStatus[row.status] = row._count._all
      itemCount += row._count._all
      itemTotalAmount = itemTotalAmount.plus(row._sum.amount ?? 0)
    }

    const storedTotalAmount = new Prisma.Decimal(batch.totalAmount)

    const computed = {
      successCount: itemCountByStatus[ITEM_STATUS.success] ?? 0,
      failedCount: itemCountByStatus[ITEM_STATUS.failed] ?? 0,
      totalAmount: itemTotalAmount.toFixed(6),
      totalRecipients: itemCount,
    }
    const stored = {
      successCount: batch.successCount,
      failedCount: batch.failedCount,
      totalAmount: storedTotalAmount.toFixed(6),
      totalRecipients: batch.totalRecipients,
    }

    const mismatches: Array<{ field: string; stored: number | string; computed: number | string; difference: number | string }> = []
    for (const field of ['successCount', 'failedCount', 'totalRecipients'] as const) {
      if (stored[field] !== computed[field]) {
        mismatches.push({
          field,
          stored: stored[field],
          computed: computed[field],
          difference: computed[field] - stored[field],
        })
      }
    }
    if (!storedTotalAmount.equals(itemTotalAmount)) {
      mismatches.push({
        field: 'totalAmount',
        stored: stored.totalAmount,
        computed: computed.totalAmount,
        difference: itemTotalAmount.minus(storedTotalAmount).toFixed(6),
      })
    }

    if (mismatches.length > 0) {
      logger.warn(
        { batchId: id, actorId: actor.id, mismatches },
        'Payout batch counters drifted from item rows',
      )
    }

    return NextResponse.json({
      batchId: batch.id,
      status: batch.status,
      reconciled: mismatches.length === 0,
      stored,
      computed,
      itemCountByStatus,
      mismatches,
      checkedAt: new Date().toISOString(),
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/payout-batches/[id]/reconciliation error')
    return NextResponse.json({ error: 'Failed to reconcile payout batch' }, { status: 500 })
  }
}
