import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// ── Types ────────────────────────────────────────────────────────────

const VALID_PERIODS = ['daily', 'weekly', 'monthly'] as const
type Period = (typeof VALID_PERIODS)[number]

export type EarningsDataPoint = {
  period: string
  amount: number
}

export type EarningsAnalyticsResponse = {
  earnings: {
    totalEarned: number
    thisMonth: number
    lastMonth: number
    currency: 'USDC'
    period: Period
    data: EarningsDataPoint[]
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Parse and validate the `period` query param.
 * Defaults to 'monthly'. Returns null if the value is present but invalid.
 */
function parsePeriod(raw: string | null): Period | null {
  if (!raw) return 'monthly'
  if ((VALID_PERIODS as readonly string[]).includes(raw)) return raw as Period
  return null
}

/**
 * Build the start-of-range date for the requested period.
 * - daily   → last 30 days
 * - weekly  → last 12 weeks
 * - monthly → last 12 months
 */
function buildRangeStart(now: Date, period: Period): Date {
  const d = new Date(now)
  if (period === 'daily') {
    d.setDate(d.getDate() - 29) // today + 29 prior days = 30 data points
    d.setHours(0, 0, 0, 0)
  } else if (period === 'weekly') {
    d.setDate(d.getDate() - 7 * 11) // current week + 11 prior weeks = 12 data points
    d.setHours(0, 0, 0, 0)
  } else {
    // monthly — go back 11 months so current month is the 12th
    d.setMonth(d.getMonth() - 11)
    d.setDate(1)
    d.setHours(0, 0, 0, 0)
  }
  return d
}

/**
 * Format a Date into the label used for each data point.
 * - daily   → "YYYY-MM-DD"
 * - weekly  → "YYYY-WNN"  (ISO week number)
 * - monthly → "YYYY-MM"
 */
function formatLabel(date: Date, period: Period): string {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')

  if (period === 'daily') {
    return `${year}-${month}-${day}`
  }

  if (period === 'weekly') {
    // ISO week: Thursday of the week determines the year
    const thursday = new Date(date)
    thursday.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7) + 3)
    const isoYear = thursday.getUTCFullYear()
    const jan4 = new Date(Date.UTC(isoYear, 0, 4))
    const weekNum = Math.ceil(
      ((thursday.getTime() - jan4.getTime()) / 86_400_000 + ((jan4.getUTCDay() + 6) % 7) + 1) / 7,
    )
    return `${isoYear}-W${String(weekNum).padStart(2, '0')}`
  }

  // monthly
  return `${year}-${month}`
}

/**
 * Group an array of completed transactions into labelled data points.
 * Transactions with no matching bucket are silently ignored.
 */
function groupByPeriod(
  transactions: Array<{ amount: unknown; createdAt: Date }>,
  period: Period,
): EarningsDataPoint[] {
  const buckets = new Map<string, number>()

  for (const tx of transactions) {
    const label = formatLabel(tx.createdAt, period)
    buckets.set(label, (buckets.get(label) ?? 0) + Number(tx.amount ?? 0))
  }

  // Return sorted ascending by label (lexicographic sort works for all three formats)
  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, amount]) => ({ period: label, amount }))
}

// ── Handler ──────────────────────────────────────────────────────────

/**
 * GET /api/routes-d/analytics/earnings
 *
 * Query params:
 *   period  "daily" | "weekly" | "monthly"  (default: "monthly")
 *
 * Response:
 *   {
 *     earnings: {
 *       totalEarned: number,   // all-time
 *       thisMonth:   number,   // current calendar month
 *       lastMonth:   number,   // previous calendar month
 *       currency:    "USDC",
 *       period:      Period,
 *       data:        Array<{ period: string; amount: number }>
 *     }
 *   }
 */
export async function GET(request: NextRequest) {
  try {
    // ── Auth ──────────────────────────────────────────────────────────
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

    // ── Validation ────────────────────────────────────────────────────
    const rawPeriod = request.nextUrl.searchParams.get('period')
    const period = parsePeriod(rawPeriod)
    if (period === null) {
      return NextResponse.json(
        { error: `Invalid period. Must be one of: ${VALID_PERIODS.join(', ')}` },
        { status: 400 },
      )
    }

    // ── Date ranges ───────────────────────────────────────────────────
    const now = new Date()
    const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999)
    const rangeStart = buildRangeStart(now, period)

    const baseWhere = {
      userId: user.id,
      type: 'payment',
      status: 'completed',
    } as const

    // ── DB queries (run in parallel) ──────────────────────────────────
    const [totalResult, thisMonthResult, lastMonthResult, periodTransactions] = await Promise.all([
      // All-time total
      prisma.transaction.aggregate({
        where: baseWhere,
        _sum: { amount: true },
      }),

      // This calendar month
      prisma.transaction.aggregate({
        where: { ...baseWhere, createdAt: { gte: startOfThisMonth } },
        _sum: { amount: true },
      }),

      // Last calendar month
      prisma.transaction.aggregate({
        where: {
          ...baseWhere,
          createdAt: { gte: startOfLastMonth, lte: endOfLastMonth },
        },
        _sum: { amount: true },
      }),

      // Raw transactions for the time-series window
      prisma.transaction.findMany({
        where: { ...baseWhere, createdAt: { gte: rangeStart } },
        select: { amount: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
    ])

    // ── Build response ────────────────────────────────────────────────
    return NextResponse.json({
      earnings: {
        totalEarned: Number(totalResult._sum.amount ?? 0),
        thisMonth: Number(thisMonthResult._sum.amount ?? 0),
        lastMonth: Number(lastMonthResult._sum.amount ?? 0),
        currency: 'USDC',
        period,
        data: groupByPeriod(periodTransactions, period),
      },
    } satisfies EarningsAnalyticsResponse)
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/analytics/earnings error')
    return NextResponse.json({ error: 'Failed to get earnings' }, { status: 500 })
  }
}
