import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { resolvePayoutBatchActor } from '../../_lib/payout-batches'

type RouteContext = { params: Promise<{ id: string }> }

const ALLOWED_STATUS_FILTERS = new Set(['pending', 'success', 'failed'])

/**
 * GET /api/payout-batches/[id]/items
 *
 * Lists PayoutItem rows in a batch with optional status filtering (?status=pending|success|failed).
 * Includes txHash and errorMessage when present.
 * Visibility restricted strictly to the batch owner (returns 404 for non-owners).
 */
export async function GET(request: NextRequest, context: RouteContext) {
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
      select: { id: true },
    })
    if (!batch) {
      return NextResponse.json({ error: 'Payout batch not found' }, { status: 404 })
    }

    const statusParam = request.nextUrl.searchParams.get('status')?.trim()
    if (statusParam && !ALLOWED_STATUS_FILTERS.has(statusParam)) {
      return NextResponse.json(
        { error: `Invalid status filter '${statusParam}'. Allowed values: pending, success, failed` },
        { status: 400 },
      )
    }

    const items = await prisma.payoutItem.findMany({
      where: {
        batchId: id,
        ...(statusParam ? { status: statusParam } : {}),
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        batchId: true,
        recipientIdentifier: true,
        amount: true,
        payoutType: true,
        status: true,
        txHash: true,
        errorMessage: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    return NextResponse.json({
      items: items.map((item) => ({
        id: item.id,
        batchId: item.batchId,
        recipientIdentifier: item.recipientIdentifier,
        amount: item.amount.toString(),
        payoutType: item.payoutType,
        status: item.status,
        txHash: item.txHash,
        errorMessage: item.errorMessage,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })),
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/payout-batches/[id]/items error')
    return NextResponse.json({ error: 'Failed to fetch payout batch items' }, { status: 500 })
  }
}
