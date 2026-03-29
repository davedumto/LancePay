import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// ── GET /api/routes-d/analytics/earnings — earnings summary ─────────

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    // Date range helpers
    const now = new Date()
    const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999)

    const baseWhere = {
      userId: user.id,
      type: 'payment',
      status: 'completed',
    }

    // Total earned (all time)
    const totalResult = await prisma.transaction.aggregate({
      where: baseWhere,
      _sum: { amount: true },
    })

    // This month
    const thisMonthResult = await prisma.transaction.aggregate({
      where: {
        ...baseWhere,
        createdAt: { gte: startOfThisMonth },
      },
      _sum: { amount: true },
    })

    // Last month
    const lastMonthResult = await prisma.transaction.aggregate({
      where: {
        ...baseWhere,
        createdAt: {
          gte: startOfLastMonth,
          lte: endOfLastMonth,
        },
      },
      _sum: { amount: true },
    })

    return NextResponse.json({
      earnings: {
        totalEarned: Number(totalResult._sum.amount ?? 0),
        thisMonth: Number(thisMonthResult._sum.amount ?? 0),
        lastMonth: Number(lastMonthResult._sum.amount ?? 0),
        currency: 'USDC',
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'Earnings analytics GET error')
    return NextResponse.json({ error: 'Failed to get earnings' }, { status: 500 })
  }
}
