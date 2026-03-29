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

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const url = new URL(request.url)
    const parsedMonths = parseInt(url.searchParams.get('months') || '6', 10)
    const months = Math.min(12, Math.max(1, Number.isNaN(parsedMonths) ? 6 : parsedMonths))

    const summary = []

    for (let i = months - 1; i >= 0; i--) {
      const date = new Date()
      const start = new Date(date.getFullYear(), date.getMonth() - i, 1)
      const end = new Date(date.getFullYear(), date.getMonth() - i + 1, 0, 23, 59, 59, 999)

      const agg = await prisma.invoice.aggregate({
        where: {
          userId: user.id,
          status: 'paid',
          paidAt: { gte: start, lte: end },
        },
        _count: { id: true },
        _sum: { amount: true },
      })

      summary.push({
        month: start.toISOString().slice(0, 7),
        invoicesPaid: agg._count.id,
        earned: Number(agg._sum.amount ?? 0),
      })
    }

    return NextResponse.json({ summary })
  } catch (error) {
    logger.error({ err: error }, 'Routes-B invoice summary GET error')
    return NextResponse.json({ error: 'Failed to get invoice summary' }, { status: 500 })
  }
}
