import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { parsePositiveMoney } from '@/lib/money'
import {
  PRORATION_SIGN_CONVENTION,
  billingPeriodStart,
  calculateProration,
  isBillingFrequency,
} from '@/lib/proration'

// POST /api/subscriptions/[id]/proration — preview the prorated credit/charge
// for moving a subscription to a new per-period price mid-cycle. This is a
// quote only: the subscription is not modified.
//
// Body:
//   newAmount   — required, new price per billing period (same frequency/interval)
//   effectiveAt — optional ISO timestamp of the change (default: now)
//   currency    — optional; when given it must match the subscription currency
//
// The current billing period is the one ending at nextGenerationDate. See
// lib/proration.ts for the time basis, rounding and sign convention.

function unprocessable(code: string, error: string) {
  return NextResponse.json({ error, code }, { status: 422 })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const payload = (body ?? {}) as Record<string, unknown>

    const newAmount = parsePositiveMoney(payload.newAmount)
    if (!newAmount) {
      return NextResponse.json(
        { error: 'newAmount must be a positive amount with at most 2 decimal places' },
        { status: 400 },
      )
    }

    let changeAt = new Date()
    if (payload.effectiveAt !== undefined) {
      if (typeof payload.effectiveAt !== 'string') {
        return NextResponse.json({ error: 'effectiveAt must be an ISO date string' }, { status: 400 })
      }
      changeAt = new Date(payload.effectiveAt)
      if (Number.isNaN(changeAt.getTime())) {
        return NextResponse.json({ error: 'effectiveAt must be a valid ISO date string' }, { status: 400 })
      }
    }

    if (payload.currency !== undefined && typeof payload.currency !== 'string') {
      return NextResponse.json({ error: 'currency must be a string' }, { status: 400 })
    }

    const subscription = await prisma.subscription.findFirst({
      where: { id, userId: user.id },
      select: {
        id: true,
        amount: true,
        currency: true,
        frequency: true,
        interval: true,
        status: true,
        nextGenerationDate: true,
      },
    })

    if (!subscription) {
      return NextResponse.json({ error: 'Subscription not found' }, { status: 404 })
    }

    if (subscription.status !== 'active') {
      return unprocessable(
        'SUBSCRIPTION_NOT_ACTIVE',
        `Cannot prorate a ${subscription.status} subscription`,
      )
    }

    if (
      typeof payload.currency === 'string' &&
      payload.currency.trim().toUpperCase() !== subscription.currency.toUpperCase()
    ) {
      return unprocessable(
        'CURRENCY_MISMATCH',
        `currency must match the subscription currency (${subscription.currency})`,
      )
    }

    if (!isBillingFrequency(subscription.frequency) || !Number.isInteger(subscription.interval) || subscription.interval < 1) {
      return unprocessable(
        'UNSUPPORTED_BILLING_PERIOD',
        'Subscription billing frequency or interval is not supported for proration',
      )
    }

    const periodEnd = subscription.nextGenerationDate
    const periodStart = billingPeriodStart(periodEnd, subscription.frequency, subscription.interval)

    if (changeAt < periodStart || changeAt > periodEnd) {
      return unprocessable(
        'EFFECTIVE_DATE_OUTSIDE_BILLING_PERIOD',
        'effectiveAt must fall within the current billing period',
      )
    }

    const result = calculateProration({
      currentAmount: subscription.amount,
      newAmount,
      periodStart,
      periodEnd,
      changeAt,
    })

    return NextResponse.json({
      subscriptionId: subscription.id,
      currency: subscription.currency,
      direction: result.direction,
      currentAmount: subscription.amount.toNumber(),
      newAmount: newAmount.toNumber(),
      billingPeriod: {
        start: periodStart.toISOString(),
        end: periodEnd.toISOString(),
      },
      effectiveAt: changeAt.toISOString(),
      remainingMs: result.remainingMs,
      periodMs: result.periodMs,
      credit: result.credit.toNumber(),
      charge: result.charge.toNumber(),
      netAmount: result.netAmount.toNumber(),
      signConvention: PRORATION_SIGN_CONVENTION,
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/subscriptions/[id]/proration error')
    return NextResponse.json({ error: 'Failed to calculate proration' }, { status: 500 })
  }
}
