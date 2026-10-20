import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { verifyAuthToken } from '@/lib/auth'

// GET /api/payout-batches/[id]/items/[itemId]
//
// Returns full detail for a single PayoutItem, including payoutType, status,
// txHash and errorMessage.
//
// Authorization: the authenticated user must own the parent PayoutBatch.
//
// 404 is returned distinctly in two cases:
//   - the item does not exist at all
//   - the item exists but belongs to a different batch than [id] in the path
// Both surface as 404 so callers cannot enumerate items across batches.

type RouteContext = { params: Promise<{ id: string; itemId: string }> | { id: string; itemId: string } }

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    // 1. Authenticate
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Authentication required' },
        { status: 401 },
      )
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Authentication required' },
        { status: 401 },
      )
    }

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'User not found' },
        { status: 401 },
      )
    }

    const { id, itemId } = await context.params

    // 2. Verify the batch exists and belongs to this user
    const batch = await prisma.payoutBatch.findUnique({ where: { id } })
    if (!batch) {
      return NextResponse.json(
        { error: 'Not Found', message: 'Payout batch not found' },
        { status: 404 },
      )
    }

    if (batch.userId !== user.id) {
      return NextResponse.json(
        { error: 'Forbidden', message: 'You do not own this payout batch' },
        { status: 403 },
      )
    }

    // 3. Fetch the item
    const item = await prisma.payoutItem.findUnique({ where: { id: itemId } })

    // 4. 404 when item does not exist OR belongs to a different batch
    //    Both cases return the same status so callers cannot enumerate items
    //    across batches they do not own.
    if (!item || item.batchId !== id) {
      return NextResponse.json(
        { error: 'Not Found', message: 'Payout item not found' },
        { status: 404 },
      )
    }

    // 5. Return full detail
    return NextResponse.json({
      item: {
        id: item.id,
        batchId: item.batchId,
        recipientIdentifier: item.recipientIdentifier,
        amount: item.amount,
        payoutType: item.payoutType,
        status: item.status,
        txHash: item.txHash,
        errorMessage: item.errorMessage,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/payout-batches/[id]/items/[itemId] error')
    return NextResponse.json(
      { error: 'Internal Server Error', message: 'Failed to fetch payout item' },
      { status: 500 },
    )
  }
}
