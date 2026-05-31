import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { createRouteLogger } from '../../_shared/logger'

const log = createRouteLogger({ route: '/api/routes-d/analytics/top-months' })

// ── GET /api/routes-d/analytics/top-months — top earning months ──────────────

function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true, timezone: true },
    })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { searchParams } = new URL(request.url)
    const rawTz = searchParams.get('tz') ?? user.timezone ?? 'UTC'

    if (!isValidTimezone(rawTz)) {
      return NextResponse.json(
        {
          error: 'Invalid timezone',
          fields: { tz: `"${rawTz}" is not a valid IANA timezone name` },
        },
        { status: 400 },
      )
    }

    const limitParam = Number(searchParams.get('limit') ?? 3)
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 12) : 3

    const paid = await prisma.invoice.findMany({
      where: { userId: user.id, status: 'paid' },
      select: { amount: true, paidAt: true },
    })

    const monthly: Record<string, number> = {}

    for (const inv of paid) {
      if (!inv.paidAt) continue

      const key = inv.paidAt
        .toLocaleDateString('en-CA', { timeZone: rawTz })
        .slice(0, 7)

      monthly[key] = (monthly[key] ?? 0) + Number(inv.amount)
    }

    const topMonths = Object.entries(monthly)
      .sort(([, a], [, b]) => b - a)
      .slice(0, limit)
      .map(([month, earned]) => ({
        month,
        earned: Number(earned.toFixed(2)),
      }))

    return NextResponse.json({ topMonths, tz: rawTz })
  } catch (error) {
    log.error({ err: error }, 'Top months analytics GET error')
    return NextResponse.json({ error: 'Failed to get top months analytics' }, { status: 500 })
  }
}
