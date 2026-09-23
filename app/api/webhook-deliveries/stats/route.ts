import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

/**
 * GET /api/webhook-deliveries/stats
 *
 * Aggregates WebhookDelivery outcomes grouped by webhookId over a configurable
 * rolling window and computes a success rate per webhook. Webhooks whose
 * success rate falls below a threshold (and that have enough samples) are
 * flagged as candidates for auto-pause so unhealthy endpoints surface.
 *
 * Query params:
 *   - windowHours (optional): rolling window size in hours (default 24, max 720)
 *   - threshold   (optional): success-rate threshold in [0,1] (default 0.9)
 *   - minDeliveries (optional): minimum terminal deliveries before a webhook can
 *                               be flagged (default 5)
 *   - userId      (optional): restrict to a single account. Admin only; a
 *                             non-admin caller is always scoped to their own
 *                             webhooks regardless of this value.
 *
 * Success rate is computed over terminal deliveries only (success + failure);
 * still-pending deliveries are reported but excluded from the denominator.
 */

const SUCCESS_STATUSES = ['delivered', 'success']
const FAILURE_STATUSES = ['failed', 'dead']

const DEFAULT_WINDOW_HOURS = 24
const MAX_WINDOW_HOURS = 720 // 30 days
const DEFAULT_THRESHOLD = 0.9
const DEFAULT_MIN_DELIVERIES = 5

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { searchParams } = new URL(request.url)

    const windowHours = parseNumber(
      searchParams.get('windowHours'),
      DEFAULT_WINDOW_HOURS,
    )
    if (windowHours === null || windowHours <= 0 || windowHours > MAX_WINDOW_HOURS) {
      return NextResponse.json(
        { error: `windowHours must be a number between 1 and ${MAX_WINDOW_HOURS}` },
        { status: 400 },
      )
    }

    const threshold = parseNumber(searchParams.get('threshold'), DEFAULT_THRESHOLD)
    if (threshold === null || threshold < 0 || threshold > 1) {
      return NextResponse.json(
        { error: 'threshold must be a number between 0 and 1' },
        { status: 400 },
      )
    }

    const minDeliveries = parseNumber(
      searchParams.get('minDeliveries'),
      DEFAULT_MIN_DELIVERIES,
    )
    if (minDeliveries === null || minDeliveries < 0) {
      return NextResponse.json(
        { error: 'minDeliveries must be a non-negative number' },
        { status: 400 },
      )
    }

    // Scope resolution: non-admins only ever see their own webhooks. Admins may
    // narrow to a single account with the userId filter.
    const requestedUserId = searchParams.get('userId')
    let scopedUserId: string
    if (user.role === 'admin') {
      scopedUserId = requestedUserId ?? ''
    } else {
      if (requestedUserId && requestedUserId !== user.id) {
        return NextResponse.json(
          { error: 'Forbidden: cannot query another account' },
          { status: 403 },
        )
      }
      scopedUserId = user.id
    }

    const windowStart = new Date(Date.now() - windowHours * 60 * 60 * 1000)

    const webhookFilter =
      scopedUserId !== '' ? { userId: scopedUserId } : undefined

    const grouped = await prisma.webhookDelivery.groupBy({
      by: ['webhookId', 'status'],
      where: {
        createdAt: { gte: windowStart },
        ...(webhookFilter ? { webhook: webhookFilter } : {}),
      },
      _count: { _all: true },
    })

    // Fold the (webhookId, status) rows into per-webhook aggregates.
    const byWebhook = new Map<
      string,
      { success: number; failure: number; pending: number; total: number }
    >()

    for (const row of grouped) {
      const count = row._count._all
      const entry =
        byWebhook.get(row.webhookId) ??
        { success: 0, failure: 0, pending: 0, total: 0 }

      if (SUCCESS_STATUSES.includes(row.status)) entry.success += count
      else if (FAILURE_STATUSES.includes(row.status)) entry.failure += count
      else entry.pending += count

      entry.total += count
      byWebhook.set(row.webhookId, entry)
    }

    const stats = Array.from(byWebhook.entries()).map(([webhookId, c]) => {
      const terminal = c.success + c.failure
      const successRate = terminal > 0 ? c.success / terminal : null
      const flaggedForAutoPause =
        successRate !== null &&
        terminal >= minDeliveries &&
        successRate < threshold

      return {
        webhookId,
        total: c.total,
        success: c.success,
        failure: c.failure,
        pending: c.pending,
        successRate,
        flaggedForAutoPause,
      }
    })

    // Surface the unhealthiest endpoints first.
    stats.sort((a, b) => {
      const ra = a.successRate ?? 1
      const rb = b.successRate ?? 1
      return ra - rb
    })

    return NextResponse.json(
      {
        stats,
        flagged: stats.filter((s) => s.flaggedForAutoPause).map((s) => s.webhookId),
        window: { hours: windowHours, since: windowStart.toISOString() },
        threshold,
        minDeliveries,
        scope: {
          userId: scopedUserId !== '' ? scopedUserId : null,
          admin: user.role === 'admin',
        },
      },
      { status: 200 },
    )
  } catch (error) {
    logger.error({ err: error }, 'GET /api/webhook-deliveries/stats error')
    return NextResponse.json({ error: 'Failed to compute webhook delivery stats' }, { status: 500 })
  }
}

function parseNumber(value: string | null, fallback: number): number | null {
  if (value === null) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
