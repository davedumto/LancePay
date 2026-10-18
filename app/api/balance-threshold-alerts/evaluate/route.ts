import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

type AlertDirection = 'below' | 'above'

interface AlertLatchState {
  crossed: boolean
  seenLastTriggeredAt: string | null
}

// Tracks per-alert hysteresis state across evaluations so an alert that has
// crossed its threshold will not re-fire until the balance moves back across
// the threshold in the opposite direction, while keeping DB writes strictly
// limited to alerts that actually fire.
const alertLatchMap = new Map<string, AlertLatchState>()

export function resetAlertLatchState() {
  alertLatchMap.clear()
}

export function isThresholdCrossed(
  direction: AlertDirection,
  balance: number,
  threshold: number,
): boolean {
  if (direction === 'below') {
    return balance < threshold
  }
  return balance > threshold
}

function normalizeTriggerKey(value: unknown): string | null {
  if (!value) return null
  const d = new Date(value as string | number | Date)
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString()
}

async function resolveAuthenticatedUser(request: NextRequest) {
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

/**
 * POST /api/balance-threshold-alerts/evaluate
 * Evaluates enabled `BalanceThresholdAlert` rules against current user balances and triggers matching alerts:
 * - Only evaluates rows where `enabled` is `true`.
 * - Avoids re-firing an alert on every evaluation once a threshold is crossed and stays crossed,
 *   only firing again after the balance moves back across the threshold in the other direction.
 * - Updates `lastTriggeredAt` only for alerts that actually fire in this evaluation.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await resolveAuthenticatedUser(request)
    if (auth.error) return auth.error
    const user = auth.user!

    let body: Record<string, unknown> = {}
    try {
      body = ((await request.json()) ?? {}) as Record<string, unknown>
    } catch {
      body = {}
    }

    const balancesByCurrency: Record<string, number> = {}
    if (body.balances && typeof body.balances === 'object') {
      for (const [currency, val] of Object.entries(
        body.balances as Record<string, unknown>,
      )) {
        const num = Number(val)
        if (Number.isFinite(num)) {
          balancesByCurrency[currency.toUpperCase()] = num
        }
      }
    }
    if (body.balance !== undefined) {
      const num = Number(body.balance)
      const curr =
        typeof body.currency === 'string' && body.currency.trim()
          ? body.currency.trim().toUpperCase()
          : 'USD'
      if (Number.isFinite(num)) {
        balancesByCurrency[curr] = num
      }
    }

    const previousBalancesByCurrency: Record<string, number> = {}
    if (body.previousBalances && typeof body.previousBalances === 'object') {
      for (const [currency, val] of Object.entries(
        body.previousBalances as Record<string, unknown>,
      )) {
        const num = Number(val)
        if (Number.isFinite(num)) {
          previousBalancesByCurrency[currency.toUpperCase()] = num
        }
      }
    }
    if (body.previousBalance !== undefined) {
      const num = Number(body.previousBalance)
      const curr =
        typeof body.currency === 'string' && body.currency.trim()
          ? body.currency.trim().toUpperCase()
          : 'USD'
      if (Number.isFinite(num)) {
        previousBalancesByCurrency[curr] = num
      }
    }

    // Fetch enabled alerts for the user
    const rawAlerts = ((await prisma.balanceThresholdAlert.findMany({
      where: {
        userId: user.id,
        enabled: true,
      },
      orderBy: { createdAt: 'asc' },
    })) ?? []) as Array<Record<string, any>>

    // Strictly filter to enabled === true in case a mock returns unfiltered rows
    const enabledAlerts = rawAlerts.filter((a) => a.enabled === true)

    const now = new Date()
    const triggeredAlerts: Array<Record<string, any>> = []
    const evaluatedAlerts: Array<Record<string, any>> = []

    for (const alert of enabledAlerts) {
      const currency = String(alert.currency ?? 'USD').toUpperCase()
      const direction = (
        String(alert.direction ?? 'below').toLowerCase() === 'above'
          ? 'above'
          : 'below'
      ) as AlertDirection
      const threshold = Number(alert.threshold)

      let currentBalance = balancesByCurrency[currency]
      if (currentBalance === undefined) {
        if (
          alert.currentBalance !== undefined &&
          Number.isFinite(Number(alert.currentBalance))
        ) {
          currentBalance = Number(alert.currentBalance)
        } else {
          continue
        }
      }

      const crossedNow = isThresholdCrossed(
        direction,
        currentBalance,
        threshold,
      )

      const triggerKey = normalizeTriggerKey(alert.lastTriggeredAt)
      const existingLatch = alertLatchMap.get(alert.id)

      let wasAlreadyCrossed: boolean
      if (previousBalancesByCurrency[currency] !== undefined) {
        wasAlreadyCrossed = isThresholdCrossed(
          direction,
          previousBalancesByCurrency[currency],
          threshold,
        )
      } else if (
        existingLatch &&
        existingLatch.seenLastTriggeredAt === triggerKey
      ) {
        wasAlreadyCrossed = existingLatch.crossed
      } else {
        wasAlreadyCrossed = Boolean(alert.lastTriggeredAt)
      }

      if (!crossedNow) {
        // Balance is on the safe side of the threshold -> re-arm the alert without writing to DB
        alertLatchMap.set(alert.id, {
          crossed: false,
          seenLastTriggeredAt: triggerKey,
        })
        evaluatedAlerts.push({
          id: alert.id,
          currency,
          direction,
          threshold,
          currentBalance,
          fired: false,
          lastTriggeredAt: triggerKey,
        })
        continue
      }

      if (wasAlreadyCrossed) {
        // Threshold was already crossed and has not recovered across the threshold -> do not re-fire
        alertLatchMap.set(alert.id, {
          crossed: true,
          seenLastTriggeredAt: triggerKey,
        })
        evaluatedAlerts.push({
          id: alert.id,
          currency,
          direction,
          threshold,
          currentBalance,
          fired: false,
          suppressedDuplicate: true,
          lastTriggeredAt: triggerKey,
        })
        continue
      }

      // Newly crossed threshold -> fire alert and update lastTriggeredAt!
      const updated = await prisma.balanceThresholdAlert.update({
        where: { id: alert.id },
        data: { lastTriggeredAt: now },
      })

      const firedTimestamp = normalizeTriggerKey(
        updated?.lastTriggeredAt ?? now,
      )
      alertLatchMap.set(alert.id, {
        crossed: true,
        seenLastTriggeredAt: firedTimestamp,
      })

      const firedEntry = {
        id: alert.id,
        userId: alert.userId ?? user.id,
        currency,
        direction,
        threshold,
        currentBalance,
        fired: true,
        lastTriggeredAt: firedTimestamp,
      }
      triggeredAlerts.push(firedEntry)
      evaluatedAlerts.push(firedEntry)
    }

    return NextResponse.json({
      evaluatedCount: evaluatedAlerts.length,
      triggeredCount: triggeredAlerts.length,
      triggeredAlerts,
      evaluations: evaluatedAlerts,
    })
  } catch (error) {
    logger?.error?.(
      { err: error },
      'POST /api/balance-threshold-alerts/evaluate error',
    )
    return NextResponse.json(
      { error: 'Failed to evaluate balance threshold alerts' },
      { status: 500 },
    )
  }
}
