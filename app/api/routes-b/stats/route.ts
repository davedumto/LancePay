import { withRequestId } from '../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireScope, RoutesBForbiddenError } from '../_lib/authz'
import { registerRoute } from '../_lib/openapi'
import { getCacheValue, setCacheValue } from '../_lib/cache'
import { withCompression } from '../_lib/with-compression'
import { errorResponse } from '../_lib/errors'
import { parseUtcDateRange } from '../_lib/date-range'
import { z } from 'zod'

// Register OpenAPI documentation
registerRoute({
  method: 'GET',
  path: '/stats',
  summary: 'Get user statistics',
  description:
    'Returns invoice statistics, total earnings, and pending withdrawals for the authenticated user.',
  responseSchema: z.object({
    invoices: z.object({
      total: z.number(),
      pending: z.number(),
      paid: z.number(),
      cancelled: z.number(),
      overdue: z.number(),
    }),
    totalEarned: z.number(),
    pendingWithdrawals: z.number(),
  }),
  tags: ['stats'],
})

type StatsPayload = {
  invoices: {
    total: number
    pending: number
    paid: number
    cancelled: number
    overdue: number
  }
  totalEarned: number
  pendingWithdrawals: number
}

type BaselinePayload = StatsPayload & {
  deltaPct: {
    totalEarned: number
    invoicesPaid: number
  }
}

function computeDeltaPct(current: number, baseline: number): number {
  if (baseline === 0) return current > 0 ? 100 : 0
  return Math.round(((current - baseline) / baseline) * 10000) / 100
}

async function GETHandler(request: NextRequest) {
  const requestId = request.headers.get('x-request-id')

  try {
    const auth = await requireScope(request, 'routes-b:read')

    const baselineFrom = request.nextUrl.searchParams.get('baselineFrom')
    const baselineTo = request.nextUrl.searchParams.get('baselineTo')

    const cacheKey = `routes-b:stats:${auth.userId}:${baselineFrom ?? ''}:${baselineTo ?? ''}`

    const cached = getCacheValue<StatsPayload | BaselinePayload>(cacheKey)

    if (cached) {
      return withCompression(
        request,
        NextResponse.json(cached, { headers: { 'X-Cache': 'HIT' } }),
      )
    }

    const user = await prisma.user.findUnique({
      where: { id: auth.userId },
    })

    if (!user) {
      return withCompression(
        request,
        errorResponse('NOT_FOUND', 'User not found', undefined, 404, requestId),
      )
    }

    const [invoiceStats, totalEarned, pendingWithdrawals] =
      await Promise.all([
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

    const counts = Object.fromEntries(
      invoiceStats.map(s => [s.status, s._count.id]),
    )

    const currentStats: StatsPayload = {
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

    if (baselineFrom && baselineTo) {
      const baselineParams = new URLSearchParams({
        from: baselineFrom,
        to: baselineTo,
      })
      const baselineRange = parseUtcDateRange(baselineParams)
      if (!baselineRange.ok) {
        return withCompression(
          request,
          errorResponse(
            'BAD_REQUEST',
            baselineRange.error.error,
            { fields: baselineRange.error.fields },
            422,
            requestId,
          ),
        )
      }

      const { from, toExclusive } = baselineRange.value

      const [baselineInvoiceStats, baselineTotalEarned] = await Promise.all([
        prisma.invoice.groupBy({
          by: ['status'],
          where: {
            userId: user.id,
            createdAt: { gte: from, lt: toExclusive },
          },
          _count: { id: true },
        }),
        prisma.transaction.aggregate({
          where: {
            userId: user.id,
            type: 'payment',
            status: 'completed',
            createdAt: { gte: from, lt: toExclusive },
          },
          _sum: { amount: true },
        }),
      ])

      const baselineCounts = Object.fromEntries(
        baselineInvoiceStats.map(s => [s.status, s._count.id]),
      )

      const baselinePaid = baselineCounts.paid ?? 0
      const baselineEarned = Number(baselineTotalEarned._sum.amount ?? 0)

      const payload: BaselinePayload = {
        ...currentStats,
        deltaPct: {
          totalEarned: computeDeltaPct(currentStats.totalEarned, baselineEarned),
          invoicesPaid: computeDeltaPct(currentStats.invoices.paid, baselinePaid),
        },
      }

      setCacheValue(cacheKey, payload, 60_000)

      return withCompression(
        request,
        NextResponse.json(payload, { headers: { 'X-Cache': 'MISS' } }),
      )
    }

    setCacheValue(cacheKey, currentStats, 60_000)

    return withCompression(
      request,
      NextResponse.json(currentStats, { headers: { 'X-Cache': 'MISS' } }),
    )
  } catch (error) {
    if (error instanceof RoutesBForbiddenError) {
      return withCompression(
        request,
        errorResponse(
          'FORBIDDEN',
          'Forbidden',
          { scope: error.code },
          403,
          requestId,
        ),
      )
    }

    return withCompression(
      request,
      errorResponse(
        'UNAUTHORIZED',
        'Unauthorized',
        undefined,
        401,
        requestId,
      ),
    )
  }
}

export const GET = withRequestId(GETHandler)