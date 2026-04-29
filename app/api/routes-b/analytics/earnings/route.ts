import { withRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { parseTzDateRange } from '../../_lib/date-range'
import { aggregateGroups } from '../../_lib/currency'

async function GETHandler(request: NextRequest) {
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

    const { from, to, toExclusive, days, tz } = parsedRange.value
    const where = {
      userId: user.id,
      type: 'payment',
      status: 'completed',
      createdAt: {
        gte: from,
        lt: toExclusive,
      },
    }

    const total = await prisma.transaction.groupBy({
      by: ['currency'],
      where,
      _sum: { amount: true },
    })

    const totalEarned = aggregateGroups(total)

    return NextResponse.json({
      earnings: {
        totalEarned,
        currency: typeof totalEarned === 'number' ? 'USDC' : 'MIXED',
        from: from.toLocaleDateString('en-CA', { timeZone: tz }),
        to: to.toLocaleDateString('en-CA', { timeZone: tz }),
        days,
        tz,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'Routes B analytics earnings GET error')
    return NextResponse.json({ error: 'Failed to get earnings' }, { status: 500 })
  }
}

export const GET = withRequestId(GETHandler)
