import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Get all withdrawal transactions for this user
    const withdrawals = await prisma.withdrawalTransaction.findMany({
      where: { userId: user.id },
      select: {
        id: true,
        amount: true,
        asset: true,
        status: true,
        anchorId: true,
        withdrawType: true,
        createdAt: true,
        completedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    })

    // Calculate analytics
    const analytics = {
      totalWithdrawals: withdrawals.length,
      totalAmount: 0,
      completedAmount: 0,
      pendingAmount: 0,
      failedAmount: 0,
      byStatus: {
        pending: 0,
        interactive: 0,
        submitted: 0,
        completed: 0,
        failed: 0,
      },
      byAsset: {} as Record<string, { count: number; amount: number }>,
      byAnchor: {} as Record<string, { count: number; amount: number }>,
      avgCompletionTime: 0, // in milliseconds
      withdrawals: [] as Array<{
        id: string
        amount: number
        asset: string
        status: string
        anchorId: string
        withdrawType: string
        createdAt: Date
        completedAt: Date | null
      }>,
    }

    const completionTimes: number[] = []

    withdrawals.forEach((withdrawal) => {
      const amount = Number(withdrawal.amount)
      analytics.withdrawals.push({
        id: withdrawal.id,
        amount,
        asset: withdrawal.asset,
        status: withdrawal.status,
        anchorId: withdrawal.anchorId,
        withdrawType: withdrawal.withdrawType,
        createdAt: withdrawal.createdAt,
        completedAt: withdrawal.completedAt,
      })
      analytics.totalAmount += amount

      // Status breakdown
      switch (withdrawal.status) {
        case 'pending':
          analytics.byStatus.pending += 1
          analytics.pendingAmount += amount
          break
        case 'interactive':
          analytics.byStatus.interactive += 1
          analytics.pendingAmount += amount
          break
        case 'submitted':
          analytics.byStatus.submitted += 1
          analytics.pendingAmount += amount
          break
        case 'completed':
          analytics.byStatus.completed += 1
          analytics.completedAmount += amount
          if (withdrawal.completedAt) {
            const time = withdrawal.completedAt.getTime() - withdrawal.createdAt.getTime()
            completionTimes.push(time)
          }
          break
        case 'failed':
          analytics.byStatus.failed += 1
          analytics.failedAmount += amount
          break
      }

      // Asset breakdown
      if (!analytics.byAsset[withdrawal.asset]) {
        analytics.byAsset[withdrawal.asset] = { count: 0, amount: 0 }
      }
      analytics.byAsset[withdrawal.asset].count += 1
      analytics.byAsset[withdrawal.asset].amount += amount

      // Anchor breakdown
      if (!analytics.byAnchor[withdrawal.anchorId]) {
        analytics.byAnchor[withdrawal.anchorId] = { count: 0, amount: 0 }
      }
      analytics.byAnchor[withdrawal.anchorId].count += 1
      analytics.byAnchor[withdrawal.anchorId].amount += amount
    })

    // Calculate average completion time
    if (completionTimes.length > 0) {
      analytics.avgCompletionTime =
        completionTimes.reduce((a, b) => a + b, 0) / completionTimes.length
    }

    return NextResponse.json(analytics)
  } catch (error) {
    logger.error({ err: error }, 'Get withdrawal analytics error')
    return NextResponse.json({ error: 'Failed to get withdrawal analytics' }, { status: 500 })
  }
}
