import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { createRouteLogger } from '../../_shared/logger'

const log = createRouteLogger({ route: '/api/routes-d/analytics/withdrawals' })

// ── GET /api/routes-d/analytics/withdrawals — withdrawal analytics ───────────

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { searchParams } = new URL(request.url)

    const fromParam = searchParams.get('from')
    const toParam = searchParams.get('to')

    const from = fromParam ? new Date(fromParam) : null
    const to = toParam ? new Date(toParam) : null

    if (fromParam && isNaN(from!.getTime())) {
      return NextResponse.json({ error: 'Invalid from date' }, { status: 400 })
    }
    if (toParam && isNaN(to!.getTime())) {
      return NextResponse.json({ error: 'Invalid to date' }, { status: 400 })
    }
    if (from && to && from > to) {
      return NextResponse.json({ error: 'from must be before or equal to to' }, { status: 400 })
    }

    const baseWhere = {
      userId: user.id,
      type: 'withdrawal',
      ...(from || to
        ? {
            createdAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
    }

    const [total, completed, pendingCount, failedCount] = await Promise.all([
      prisma.transaction.aggregate({
        where: baseWhere,
        _count: { id: true },
        _sum: { amount: true },
      }),
      prisma.transaction.aggregate({
        where: { ...baseWhere, status: 'completed' },
        _count: { id: true },
        _sum: { amount: true },
      }),
      prisma.transaction.count({ where: { ...baseWhere, status: 'pending' } }),
      prisma.transaction.count({ where: { ...baseWhere, status: 'failed' } }),
    ])

    return NextResponse.json({
      withdrawals: {
        totalCount: total._count.id,
        totalAmount: Number(total._sum.amount ?? 0),
        completedCount: completed._count.id,
        completedAmount: Number(completed._sum.amount ?? 0),
        pendingCount,
        failedCount,
        currency: 'USDC',
      },
    })
  } catch (error) {
    log.error({ err: error }, 'Withdrawal analytics GET error')
    return NextResponse.json({ error: 'Failed to get withdrawal analytics' }, { status: 500 })
  }
}
