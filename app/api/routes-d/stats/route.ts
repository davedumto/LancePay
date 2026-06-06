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
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const [invoiceStats, totalEarned, pendingWithdrawals] = await Promise.all([
      prisma.invoice.groupBy({
        by: ['status'],
        where: { userId: user.id },
        _count: { id: true },
      }),
      prisma.transaction.aggregate({
        where: {
          userId: user.id,
          type: 'payment',
          status: 'completed',
        },
        _sum: { amount: true },
      }),
      prisma.transaction.count({
        where: {
          userId: user.id,
          type: 'withdrawal',
          status: 'pending',
        },
      }),
    ])

    const counts = Object.fromEntries(invoiceStats.map((s) => [s.status, s._count.id]))

    return NextResponse.json({
      invoices: {
        total: invoiceStats.reduce((sum, s) => sum + s._count.id, 0),
        pending: counts.pending ?? 0,
        paid: counts.paid ?? 0,
        cancelled: counts.cancelled ?? 0,
        overdue: counts.overdue ?? 0,
      },
      totalEarned: Number(totalEarned._sum.amount ?? 0),
      pendingWithdrawals,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/stats error')
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
