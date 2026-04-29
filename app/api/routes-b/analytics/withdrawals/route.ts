import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { parseTzDateRange } from '../../_lib/date-range'

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
      select: { id: true, timezone: true },
    })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const url = new URL(request.url)
    const parsedRange = parseTzDateRange(url.searchParams, user.timezone)
    if (!parsedRange.ok) {
      return NextResponse.json(parsedRange.error, { status: 400 })
    }

    const { from, toExclusive, tz } = parsedRange.value
    const where = {
      userId: user.id,
      type: 'withdrawal',
      createdAt: { gte: from, lt: toExclusive },
    }

    const [total, completed, pending, failed] = await Promise.all([
      prisma.transaction.aggregate({
        where,
        _count: { id: true },
        _sum: { amount: true },
      }),
      prisma.transaction.aggregate({
        where: { ...where, status: 'completed' },
        _count: { id: true },
        _sum: { amount: true },
      }),
      prisma.transaction.count({ where: { ...where, status: 'pending' } }),
      prisma.transaction.count({ where: { ...where, status: 'failed' } }),
    ])

    return NextResponse.json({
      withdrawals: {
        totalCount: total._count.id,
        totalAmount: Number(total._sum.amount ?? 0),
        completedCount: completed._count.id,
        completedAmount: Number(completed._sum.amount ?? 0),
        pendingCount: pending,
        failedCount: failed,
        currency: 'USDC',
        tz,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'Routes B analytics withdrawals GET error')
    return NextResponse.json({ error: 'Failed to get withdrawal stats' }, { status: 500 })
  }
}
