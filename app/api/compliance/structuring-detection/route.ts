import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { envNumber } from '@/lib/env'

/**
 * Detection heuristic
 * ---------------------------------------------------------------------------
 * A user is flagged when, within a rolling time window, they have at least
 * MIN_CLUSTER_SIZE outbound withdrawals that each individually sit in the
 * "near threshold" band (>= NEAR_THRESHOLD_RATIO * threshold and < threshold)
 * - i.e. a pattern of payouts that look deliberately kept just under a
 * reporting threshold rather than a single large one.
 *
 * To avoid flagging normal recurring invoice payments that happen to land
 * near the threshold by chance:
 *  - Only "withdrawal" transactions are considered. Recurring invoice
 *    payments are recorded as "payment" transactions tied to an invoiceId
 *    and are excluded entirely.
 *  - A cluster only counts if the withdrawals were made to more than one
 *    distinct bank account OR are spaced unevenly (not a fixed recurring
 *    cadence), since a legitimate recurring payout to the same account on a
 *    steady schedule is a normal usage pattern, not structuring.
 *  - Completed/failed withdrawals are ignored; only "pending" and
 *    "completed" withdrawals within the window count as real fund movement
 *    (a failed withdrawal never actually moved money).
 *
 * The exact threshold value is intentionally never included in API
 * responses - only relative signal (how close to it, and how many hits).
 */

const REPORTING_THRESHOLD_USD = envNumber('STRUCTURING_REPORTING_THRESHOLD_USD', 10000)
const NEAR_THRESHOLD_RATIO = envNumber('STRUCTURING_NEAR_THRESHOLD_RATIO', 0.8)
const WINDOW_DAYS = envNumber('STRUCTURING_WINDOW_DAYS', 7, { integer: true })
const MIN_CLUSTER_SIZE = envNumber('STRUCTURING_MIN_CLUSTER_SIZE', 3, { integer: true })

const ALLOWED_ROLES = new Set(['admin', 'compliance'])

interface WithdrawalRow {
  id: string
  userId: string
  amount: any
  bankAccountId: string | null
  createdAt: Date
}

function toWindowStart(): Date {
  const start = new Date()
  start.setDate(start.getDate() - WINDOW_DAYS)
  return start
}

function isNearThreshold(amount: number): boolean {
  return amount >= REPORTING_THRESHOLD_USD * NEAR_THRESHOLD_RATIO && amount < REPORTING_THRESHOLD_USD
}

function buildFlags(rows: WithdrawalRow[]) {
  const byUser = new Map<string, WithdrawalRow[]>()
  for (const row of rows) {
    const list = byUser.get(row.userId) ?? []
    list.push(row)
    byUser.set(row.userId, list)
  }

  const flags: Array<{
    userId: string
    matchCount: number
    distinctBankAccounts: number
    windowStart: string
    windowEnd: string
    lastTransactionAt: string
  }> = []

  for (const [userId, txns] of byUser) {
    const nearThreshold = txns.filter((t) => isNearThreshold(Number(t.amount)))
    if (nearThreshold.length < MIN_CLUSTER_SIZE) continue

    const distinctBankAccounts = new Set(nearThreshold.map((t) => t.bankAccountId ?? 'unknown')).size

    // Require either multiple destination accounts, or irregular spacing
    // between transactions, to avoid flagging a single steady recurring
    // payout to the same account.
    const sorted = [...nearThreshold].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    const gaps: number[] = []
    for (let i = 1; i < sorted.length; i++) {
      gaps.push(sorted[i].createdAt.getTime() - sorted[i - 1].createdAt.getTime())
    }
    const avgGap = gaps.reduce((sum, g) => sum + g, 0) / (gaps.length || 1)
    const maxDeviation = gaps.reduce((max, g) => Math.max(max, Math.abs(g - avgGap)), 0)
    const irregularSpacing = gaps.length === 0 || (avgGap > 0 && maxDeviation / avgGap > 0.25)

    if (distinctBankAccounts <= 1 && !irregularSpacing) continue

    flags.push({
      userId,
      matchCount: nearThreshold.length,
      distinctBankAccounts,
      windowStart: sorted[0].createdAt.toISOString(),
      windowEnd: sorted[sorted.length - 1].createdAt.toISOString(),
      lastTransactionAt: sorted[sorted.length - 1].createdAt.toISOString(),
    })
  }

  return flags.sort((a, b) => b.matchCount - a.matchCount)
}

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const actor = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!actor) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    if (!ALLOWED_ROLES.has(actor.role)) {
      return NextResponse.json(
        { error: 'Forbidden: admin or compliance access required' },
        { status: 403 },
      )
    }

    const windowStart = toWindowStart()

    const withdrawals = await prisma.transaction.findMany({
      where: {
        type: 'withdrawal',
        status: { in: ['pending', 'completed'] },
        invoiceId: null,
        createdAt: { gte: windowStart },
      },
      select: {
        id: true,
        userId: true,
        amount: true,
        bankAccountId: true,
        createdAt: true,
      },
    })

    const flags = buildFlags(withdrawals as WithdrawalRow[])

    logger.info(
      { flaggedUsers: flags.length, windowDays: WINDOW_DAYS, actorId: actor.id },
      'Structuring detection scan completed',
    )

    return NextResponse.json({
      windowDays: WINDOW_DAYS,
      flaggedUsers: flags.length,
      flags,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/compliance/structuring-detection error')
    return NextResponse.json({ error: 'Failed to run structuring detection' }, { status: 500 })
  }
}
