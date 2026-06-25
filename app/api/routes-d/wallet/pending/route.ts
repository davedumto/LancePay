import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
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

    const pendingTransactions = await prisma.transaction.findMany({
      where: { userId: user.id, status: 'pending' },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        type: true,
        amount: true,
        currency: true,
        status: true,
        createdAt: true,
        expectedSettlementAt: true,
      },
    })

    const totalPendingByCurrency = pendingTransactions.reduce<Record<string, number>>(
      (acc, tx) => {
        const key = tx.currency ?? 'unknown'
        acc[key] = (acc[key] ?? 0) + Number(tx.amount)
        return acc
      },
      {},
    )

    return NextResponse.json({
      pending: pendingTransactions,
      totals: totalPendingByCurrency,
      count: pendingTransactions.length,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /wallet/pending error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
