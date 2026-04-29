import { withRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { parseTzDateRange } from '../../_lib/date-range'
import { withCompression } from '../../_lib/with-compression'

const GROUP_BY_TO_DATE_TRUNC: Record<string, 'day' | 'week' | 'month'> = {
  day: 'day',
  week: 'week',
  month: 'month',
}

async function GETHandler(request: NextRequest) {
  try {
    const authToken = request.headers
      .get('authorization')
      ?.replace('Bearer ', '')

    if (!authToken) {
      return withCompression(
        request,
        NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      )
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return withCompression(
        request,
        NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      )
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true, timezone: true },
    })

    if (!user) {
      return withCompression(
        request,
        NextResponse.json({ error: 'User not found' }, { status: 404 }),
      )
    }

    const url = new URL(request.url)
    const parsedRange = parseTzDateRange(url.searchParams, user.timezone)

    if (!parsedRange.ok) {
      return withCompression(
        request,
        NextResponse.json(parsedRange.error, { status: 400 }),
      )
    }

    const requestedGroupBy = url.searchParams.get('groupBy') ?? 'month'
    const groupBy = GROUP_BY_TO_DATE_TRUNC[requestedGroupBy]

    if (!groupBy) {
      return withCompression(
        request,
        NextResponse.json(
          { error: 'groupBy must be one of: month, week, day' },
          { status: 400 },
        ),
      )
    }

    const { from, toExclusive, tz } = parsedRange.value

    // Fallback path if raw queries are unavailable
    if (typeof prisma.$queryRawUnsafe !== 'function') {
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
        prisma.transaction.count({
          where: { ...where, status: 'pending' },
        }),
        prisma.transaction.count({
          where: { ...where, status: 'failed' },
        }),
      ])

      return withCompression(
        request,
        NextResponse.json({
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
        }),
      )
    }

    const rows = await prisma.$queryRawUnsafe<
      Array<{
        bucket: Date
        count: bigint
        total_amount: unknown
        avg_amount: unknown
      }>
    >(
      `
      SELECT
        DATE_TRUNC('${groupBy}', "createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket,
        COUNT(*)::bigint AS count,
        COALESCE(SUM("amount"), 0) AS total_amount,
        COALESCE(AVG("amount"), 0) AS avg_amount
      FROM "Transaction"
      WHERE "userId" = $1
        AND "type" = 'withdrawal'
        AND "createdAt" >= $2
        AND "createdAt" < $3
      GROUP BY bucket
      ORDER BY bucket ASC
      `,
      user.id,
      from,
      toExclusive,
    )

    return withCompression(
      request,
      NextResponse.json({
        groupBy,
        tz,
        buckets: rows.map(row => ({
          bucket: row.bucket.toISOString(),
          count: Number(row.count),
          totalAmount: Number(row.total_amount ?? 0),
          avgAmount: Number(row.avg_amount ?? 0),
        })),
      }),
    )
  } catch (error) {
    logger.error({ err: error }, 'Routes B analytics withdrawals GET error')

    return withCompression(
      request,
      NextResponse.json(
        { error: 'Failed to get withdrawal stats' },
        { status: 500 },
      ),
    )
  }
}

export const GET = withRequestId(GETHandler)