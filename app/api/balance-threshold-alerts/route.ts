import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export const VALID_ALERT_DIRECTIONS = ['below', 'above'] as const
export type AlertDirection = (typeof VALID_ALERT_DIRECTIONS)[number]

async function authenticate(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return {
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    }
  }
  const token = authHeader.slice(7).trim()
  if (!token) {
    return {
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    }
  }

  const claims = await verifyAuthToken(token)
  if (!claims) {
    return {
      error: NextResponse.json({ error: 'Invalid token' }, { status: 401 }),
    }
  }

  const user =
    (await prisma.user.findUnique({ where: { privyId: claims.userId } })) ??
    (await prisma.user.findUnique({ where: { id: claims.userId } }))
  if (!user) {
    return {
      error: NextResponse.json({ error: 'User not found' }, { status: 404 }),
    }
  }

  return { user }
}

function serializeAlert(alert: Record<string, any>) {
  return {
    id: alert.id,
    userId: alert.userId,
    currency: alert.currency ?? 'USD',
    direction: alert.direction,
    threshold: Number(alert.threshold),
    enabled: alert.enabled ?? true,
    lastTriggeredAt: alert.lastTriggeredAt
      ? new Date(alert.lastTriggeredAt).toISOString()
      : null,
    createdAt: alert.createdAt
      ? new Date(alert.createdAt).toISOString()
      : null,
    updatedAt: alert.updatedAt
      ? new Date(alert.updatedAt).toISOString()
      : null,
  }
}

/**
 * GET /api/balance-threshold-alerts
 * Lists all `BalanceThresholdAlert` rules belonging to the authenticated user.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await authenticate(request)
    if (auth.error) return auth.error
    const user = auth.user!

    const { searchParams } = new URL(request.url)
    const currencyFilter = searchParams.get('currency')?.trim().toUpperCase()
    const enabledParam = searchParams.get('enabled')

    const where: Record<string, unknown> = {
      userId: user.id,
      ...(currencyFilter ? { currency: currencyFilter } : {}),
      ...(enabledParam === 'true'
        ? { enabled: true }
        : enabledParam === 'false'
          ? { enabled: false }
          : {}),
    }

    const alerts = ((await prisma.balanceThresholdAlert.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    })) ?? []) as Array<Record<string, any>>

    return NextResponse.json({
      alerts: alerts.map(serializeAlert),
      total: alerts.length,
    })
  } catch (error) {
    logger?.error?.({ err: error }, 'GET /api/balance-threshold-alerts error')
    return NextResponse.json(
      { error: 'Failed to fetch balance threshold alerts' },
      { status: 500 },
    )
  }
}

/**
 * POST /api/balance-threshold-alerts
 * Creates a `BalanceThresholdAlert` rule to notify a user when their balance crosses a threshold:
 * - Validates `direction` is either `'below'` or `'above'` and `threshold` is non-negative (`>= 0`).
 * - Allows multiple alerts per user for different currencies or thresholds.
 * - Defaults `enabled` to `true`.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await authenticate(request)
    if (auth.error) return auth.error
    const user = auth.user!

    let body: Record<string, unknown>
    try {
      body = ((await request.json()) ?? {}) as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const rawDirection =
      typeof body.direction === 'string'
        ? body.direction.trim().toLowerCase()
        : ''
    if (
      !(VALID_ALERT_DIRECTIONS as readonly string[]).includes(rawDirection)
    ) {
      return NextResponse.json(
        {
          error: 'direction must be either "below" or "above"',
          code: 'INVALID_DIRECTION',
        },
        { status: 400 },
      )
    }
    const direction = rawDirection as AlertDirection

    if (
      body.threshold === undefined ||
      body.threshold === null ||
      body.threshold === '' ||
      typeof body.threshold === 'boolean'
    ) {
      return NextResponse.json(
        {
          error: 'threshold is required and must be a non-negative number',
          code: 'INVALID_THRESHOLD',
        },
        { status: 400 },
      )
    }

    const parsedThreshold = Number(body.threshold)
    if (!Number.isFinite(parsedThreshold) || parsedThreshold < 0) {
      return NextResponse.json(
        {
          error: 'threshold must be a non-negative number (>= 0)',
          code: 'INVALID_THRESHOLD',
        },
        { status: 400 },
      )
    }

    const normalizedThreshold = Math.round(parsedThreshold * 100) / 100

    const currency =
      typeof body.currency === 'string' && body.currency.trim()
        ? body.currency.trim().toUpperCase()
        : 'USD'

    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      return NextResponse.json(
        { error: 'enabled must be a boolean', code: 'INVALID_ENABLED' },
        { status: 400 },
      )
    }
    const enabled = body.enabled !== undefined ? body.enabled : true

    const created = await prisma.balanceThresholdAlert.create({
      data: {
        userId: user.id,
        currency,
        direction,
        threshold: normalizedThreshold,
        enabled,
      },
    })

    logger?.info?.(
      {
        userId: user.id,
        alertId: created.id,
        currency,
        direction,
        threshold: normalizedThreshold,
        enabled,
      },
      'Created balance threshold alert',
    )

    return NextResponse.json(
      {
        alert: serializeAlert(created),
      },
      { status: 201 },
    )
  } catch (error) {
    logger?.error?.({ err: error }, 'POST /api/balance-threshold-alerts error')
    return NextResponse.json(
      { error: 'Failed to create balance threshold alert' },
      { status: 500 },
    )
  }
}
