import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 401 })

    const { id } = await params
    if (!id || id.trim() === '') {
      return NextResponse.json({ error: 'Batch id is required' }, { status: 400 })
    }

    const batch = await prisma.payoutBatch.findFirst({
      where: { id, userId: user.id },
      select: {
        id: true,
        status: true,
        totalAmount: true,
        totalRecipients: true,
        successCount: true,
        failedCount: true,
        scheduledAt: true,
        createdAt: true,
        completedAt: true,
        items: {
          select: {
            id: true,
            recipientIdentifier: true,
            amount: true,
            payoutType: true,
            status: true,
            txHash: true,
            errorMessage: true,
            updatedAt: true,
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    })
    if (!batch) return NextResponse.json({ error: 'Batch not found' }, { status: 404 })

    const itemStatusCounts = batch.items.reduce<Record<string, number>>((acc, item) => {
      acc[item.status] = (acc[item.status] ?? 0) + 1
      return acc
    }, {})

    return NextResponse.json({ batch: { ...batch, itemStatusCounts } })
  } catch (error) {
    logger.error({ err: error }, 'GET /withdrawals/batch/[id] error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
