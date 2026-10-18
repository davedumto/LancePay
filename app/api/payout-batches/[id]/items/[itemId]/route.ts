import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

type RouteContext = {
  params: Promise<{ id: string; itemId: string }> | { id: string; itemId: string }
}

async function resolveRouteParams(context?: RouteContext) {
  if (!context?.params) return { id: '', itemId: '' }
  const resolved = await Promise.resolve(context.params)
  return {
    id: (resolved?.id ?? '').trim(),
    itemId: (resolved?.itemId ?? '').trim(),
  }
}

async function resolveAuthenticatedUser(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: 'Unauthorized', status: 401 as const, user: null }
  }
  const token = authHeader.slice(7).trim()
  if (!token) {
    return { error: 'Unauthorized', status: 401 as const, user: null }
  }

  const claims = await verifyAuthToken(token)
  if (!claims) {
    return { error: 'Unauthorized', status: 401 as const, user: null }
  }

  let userId = claims.userId
  if (typeof prisma.user?.findUnique === 'function') {
    const dbUser =
      (await prisma.user.findUnique({
        where: { privyId: claims.userId },
        select: { id: true },
      })) ??
      (await prisma.user.findUnique({
        where: { id: claims.userId },
        select: { id: true },
      }))

    if (!dbUser) {
      return { error: 'User not found', status: 404 as const, user: null }
    }
    userId = dbUser.id
  }

  return { error: null, status: 200 as const, user: { id: userId } }
}

function extractItemErrorHistory(
  item: {
    id: string
    recipientIdentifier: string
    errorMessage?: string | null
    updatedAt?: Date | string | null
  },
  batchResults: unknown,
): Array<{ message: string; recordedAt: string | null; source: string }> {
  const history: Array<{
    message: string
    recordedAt: string | null
    source: string
  }> = []

  if (Array.isArray(batchResults)) {
    for (const entry of batchResults) {
      if (!entry || typeof entry !== 'object') continue
      const rec = entry as Record<string, any>
      const matchesItem =
        rec.itemId === item.id ||
        rec.id === item.id ||
        (rec.recipientIdentifier &&
          rec.recipientIdentifier === item.recipientIdentifier)
      const errMsg =
        typeof rec.errorMessage === 'string'
          ? rec.errorMessage.trim()
          : typeof rec.error === 'string'
            ? rec.error.trim()
            : ''
      if (matchesItem && errMsg) {
        history.push({
          message: errMsg,
          recordedAt: rec.timestamp
            ? new Date(rec.timestamp).toISOString()
            : null,
          source: 'batch_results',
        })
      }
    }
  }

  if (typeof item.errorMessage === 'string' && item.errorMessage.trim()) {
    const msg = item.errorMessage.trim()
    const alreadyRecorded = history.some((h) => h.message === msg)
    if (!alreadyRecorded) {
      history.push({
        message: msg,
        recordedAt: item.updatedAt
          ? new Date(item.updatedAt).toISOString()
          : null,
        source: 'item_record',
      })
    }
  }

  return history
}

/**
 * GET /api/payout-batches/[id]/items/[itemId]
 * Returns detailed status for a single PayoutItem within a batch:
 * - Restricts visibility to the batch owner.
 * - Returns 404 distinctly when the item exists but belongs to a different batch than the one in the path.
 * - Includes `payoutType` and `status` alongside `txHash`, `errorMessage`, and `errorHistory` / `errorDetail`.
 */
export async function GET(req: NextRequest, context: RouteContext) {
  try {
    const auth = await resolveAuthenticatedUser(req)
    if (auth.error || !auth.user) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const { id: batchId, itemId } = await resolveRouteParams(context)
    if (!batchId || !itemId) {
      return NextResponse.json(
        { error: 'Payout batch ID and item ID are required' },
        { status: 400 },
      )
    }

    const batch = await prisma.payoutBatch.findUnique({
      where: { id: batchId },
      select: {
        id: true,
        userId: true,
        status: true,
        results: true,
      },
    })

    if (!batch) {
      return NextResponse.json(
        { error: 'Payout batch not found', code: 'PAYOUT_BATCH_NOT_FOUND' },
        { status: 404 },
      )
    }

    if (batch.userId !== auth.user.id) {
      return NextResponse.json(
        {
          error: 'Forbidden: only the batch owner can view this payout item',
          code: 'FORBIDDEN_NOT_BATCH_OWNER',
        },
        { status: 403 },
      )
    }

    const item = await prisma.payoutItem.findUnique({
      where: { id: itemId },
    })

    if (!item) {
      return NextResponse.json(
        { error: 'Payout item not found', code: 'PAYOUT_ITEM_NOT_FOUND' },
        { status: 404 },
      )
    }

    if (item.batchId !== batch.id) {
      return NextResponse.json(
        {
          error:
            'Payout item not found in the specified payout batch (belongs to a different batch)',
          code: 'PAYOUT_ITEM_BATCH_MISMATCH',
        },
        { status: 404 },
      )
    }

    const errorHistory = extractItemErrorHistory(item, batch.results)
    const amountStr =
      item.amount !== undefined && item.amount !== null
        ? String(item.amount)
        : '0'

    const formattedItem = {
      id: item.id,
      batchId: item.batchId,
      recipientIdentifier: item.recipientIdentifier,
      amount: amountStr,
      payoutType: item.payoutType,
      status: item.status,
      txHash: item.txHash ?? null,
      errorMessage: item.errorMessage ?? null,
      errorDetail: item.errorMessage
        ? {
            latestError: item.errorMessage,
            history: errorHistory,
          }
        : errorHistory.length > 0
          ? {
              latestError: errorHistory[errorHistory.length - 1].message,
              history: errorHistory,
            }
          : null,
      errorHistory,
      createdAt: item.createdAt ? new Date(item.createdAt).toISOString() : null,
      updatedAt: item.updatedAt ? new Date(item.updatedAt).toISOString() : null,
    }

    return NextResponse.json({
      item: formattedItem,
      payoutType: formattedItem.payoutType,
      status: formattedItem.status,
      txHash: formattedItem.txHash,
      errorMessage: formattedItem.errorMessage,
      errorDetail: formattedItem.errorDetail,
    })
  } catch (err) {
    logger?.error?.(
      { err },
      'GET /api/payout-batches/[id]/items/[itemId] error',
    )
    return NextResponse.json(
      { error: 'Failed to fetch payout item status' },
      { status: 500 },
    )
  }
}
