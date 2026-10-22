import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { ITEM_STATUS, resolvePayoutBatchActor } from '../_lib/payout-batches'

// GET /api/payout-batches/summary?from=&to=
//
// Aggregates the caller's own payout batches: count of batches per status,
// total amount disbursed (items in `success`) and total amount failed (items
// in `failed`). `from` / `to` optionally filter on PayoutBatch.createdAt; a
// date-only `to` is treated as inclusive of that whole day. Scoping is always
// by the authenticated user's id — there is no way to request another user's
// batches, admin or not.

function parseDate(value: string | null, endOfDay = false): Date | null | undefined {
  if (value === null) return null

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return undefined

  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    date.setUTCHours(23, 59, 59, 999)
  }
  return date
}

export async function GET(request: NextRequest) {
  try {
    const auth = await resolvePayoutBatchActor(request)
    if ('response' in auth) return auth.response
    const { actor } = auth

    const { searchParams } = new URL(request.url)
    const from = parseDate(searchParams.get('from'))
    const to = parseDate(searchParams.get('to'), true)

    if (from === undefined) {
      return NextResponse.json({ error: 'from must be a valid ISO 8601 date' }, { status: 400 })
    }
    if (to === undefined) {
      return NextResponse.json({ error: 'to must be a valid ISO 8601 date' }, { status: 400 })
    }
    if (from && to && from > to) {
      return NextResponse.json({ error: 'from must not be later than to' }, { status: 400 })
    }

    const batchWhere: Prisma.PayoutBatchWhereInput = {
      userId: actor.id,
      ...(from || to
        ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
        : {}),
    }

    const [batchesByStatus, itemTotals] = await Promise.all([
      prisma.payoutBatch.groupBy({
        by: ['status'],
        where: batchWhere,
        _count: { _all: true },
      }),
      prisma.payoutItem.groupBy({
        by: ['status'],
        where: {
          status: { in: [ITEM_STATUS.success, ITEM_STATUS.failed] },
          batch: batchWhere,
        },
        _sum: { amount: true },
      }),
    ])

    const countByStatus: Record<string, number> = {}
    let totalBatches = 0
    for (const row of batchesByStatus) {
      countByStatus[row.status] = row._count._all
      totalBatches += row._count._all
    }

    const sumFor = (status: string) =>
      new Prisma.Decimal(itemTotals.find((row) => row.status === status)?._sum.amount ?? 0)

    return NextResponse.json({
      summary: {
        totalBatches,
        countByStatus,
        totalDisbursedAmount: sumFor(ITEM_STATUS.success).toFixed(6),
        totalFailedAmount: sumFor(ITEM_STATUS.failed).toFixed(6),
      },
      filters: {
        from: from ? from.toISOString() : null,
        to: to ? to.toISOString() : null,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/payout-batches/summary error')
    return NextResponse.json({ error: 'Failed to load payout batch summary' }, { status: 500 })
  }
}
