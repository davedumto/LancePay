import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireScope, RoutesBForbiddenError } from '../_lib/authz'
import { registerRoute } from '../_lib/openapi'
import { getCacheValue, setCacheValue } from '../_lib/cache'
import { z } from 'zod'

// Register OpenAPI documentation
registerRoute({
  method: 'GET',
  path: '/stats',
  summary: 'Get user statistics',
  description: 'Returns invoice statistics, total earnings, and pending withdrawals for the authenticated user.',
  responseSchema: z.object({
    invoices: z.object({
      total: z.number(),
      pending: z.number(),
      paid: z.number(),
      cancelled: z.number(),
      overdue: z.number()
    }),
    totalEarned: z.number(),
    pendingWithdrawals: z.number()
  }),
  tags: ['stats']
})

export async function GET(request: NextRequest) {
  try {
    const auth = await requireScope(request, 'routes-b:read')
    const cacheKey = `routes-b:stats:${auth.userId}`
    const cached = getCacheValue<{
      invoices: { total: number; pending: number; paid: number; cancelled: number; overdue: number }
      totalEarned: number
      pendingWithdrawals: number
    }>(cacheKey)
    if (cached) {
      return NextResponse.json(cached, { headers: { 'X-Cache': 'HIT' } })
    }

    const user = await prisma.user.findUnique({ where: { id: auth.userId } })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const [invoiceStats, totalEarned, pendingWithdrawals] = await Promise.all([
      prisma.invoice.groupBy({
        by: ['status'],
        where: { userId: user.id },
        _count: { id: true },
      }),
      prisma.transaction.aggregate({
        where: { userId: user.id, type: 'payment', status: 'completed' },
        _sum: { amount: true },
      }),
      prisma.transaction.count({
        where: { userId: user.id, type: 'withdrawal', status: 'pending' },
      }),
    ])

    const counts = Object.fromEntries(invoiceStats.map((s) => [s.status, s._count.id]))

    const payload = {
      invoices: {
        total: invoiceStats.reduce((sum, s) => sum + s._count.id, 0),
        pending: counts.pending ?? 0,
        paid: counts.paid ?? 0,
        cancelled: counts.cancelled ?? 0,
        overdue: counts.overdue ?? 0,
      },
      totalEarned: Number(totalEarned._sum.amount ?? 0),
      pendingWithdrawals,
    }

    setCacheValue(cacheKey, payload, 60_000)
    return NextResponse.json(payload, { headers: { 'X-Cache': 'MISS' } })
  } catch (error) {
    if (error instanceof RoutesBForbiddenError) {
      return NextResponse.json({ error: 'Forbidden', code: error.code }, { status: 403 })
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}
