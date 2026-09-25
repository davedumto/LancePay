import { Decimal } from '@prisma/client/runtime/library'
import { roundMoney } from '@/lib/money'

// Proration for a subscription changing price part-way through a billing
// period.
//
// Time basis: every instant is compared in epoch milliseconds, so leap days,
// month lengths and DST are all accounted for by the real elapsed time.
// The billing period is the half-open interval [periodStart, periodEnd):
// a change at periodStart uses the whole period, a change at periodEnd uses
// none of it.
//
// Sign convention: netAmount = charge - credit.
//   netAmount > 0  → the customer owes this amount (upgrade)
//   netAmount < 0  → the customer is owed this amount as credit (downgrade)
//   netAmount = 0  → nothing to settle
// credit and charge are always reported as non-negative amounts.
//
// Rounding: credit and charge are each rounded to cents (half away from
// zero) and netAmount is their difference, so the three figures always
// reconcile exactly.

export const SUPPORTED_BILLING_FREQUENCIES = ['daily', 'weekly', 'monthly', 'yearly'] as const
export type BillingFrequency = (typeof SUPPORTED_BILLING_FREQUENCIES)[number]

export const PRORATION_SIGN_CONVENTION =
  'netAmount = charge - credit; positive means the customer owes the amount, negative means the customer is credited the amount'

export type ProrationDirection = 'upgrade' | 'downgrade' | 'none'

export interface ProrationInput {
  currentAmount: Decimal
  newAmount: Decimal
  periodStart: Date
  periodEnd: Date
  changeAt: Date
}

export interface ProrationResult {
  direction: ProrationDirection
  periodMs: number
  remainingMs: number
  credit: Decimal
  charge: Decimal
  netAmount: Decimal
}

export function isBillingFrequency(value: string): value is BillingFrequency {
  return (SUPPORTED_BILLING_FREQUENCIES as readonly string[]).includes(value)
}

function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
}

function subtractUtcMonths(date: Date, months: number): Date {
  const totalMonths = date.getUTCFullYear() * 12 + date.getUTCMonth() - months
  const year = Math.floor(totalMonths / 12)
  const month = totalMonths - year * 12
  const day = Math.min(date.getUTCDate(), daysInUtcMonth(year, month))
  return new Date(
    Date.UTC(
      year,
      month,
      day,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  )
}

/**
 * Start of the billing period that ends at `periodEnd` (a subscription's
 * nextGenerationDate). Calendar arithmetic is done in UTC; when the same day
 * does not exist in the earlier month it clamps to that month's last day
 * (e.g. monthly ending 31 Mar starts 28/29 Feb).
 */
export function billingPeriodStart(periodEnd: Date, frequency: BillingFrequency, interval: number): Date {
  switch (frequency) {
    case 'daily':
      return new Date(periodEnd.getTime() - interval * 86_400_000)
    case 'weekly':
      return new Date(periodEnd.getTime() - interval * 7 * 86_400_000)
    case 'monthly':
      return subtractUtcMonths(periodEnd, interval)
    case 'yearly':
      return subtractUtcMonths(periodEnd, interval * 12)
  }
}

/**
 * Nets the unused share of the current price (credit) against the remaining
 * share of the new price (charge). Caller must ensure
 * periodStart <= changeAt <= periodEnd and periodStart < periodEnd.
 */
export function calculateProration(input: ProrationInput): ProrationResult {
  const periodMs = input.periodEnd.getTime() - input.periodStart.getTime()
  const remainingMs = input.periodEnd.getTime() - input.changeAt.getTime()

  const credit = roundMoney(input.currentAmount.mul(remainingMs).div(periodMs))
  const charge = roundMoney(input.newAmount.mul(remainingMs).div(periodMs))

  const comparison = input.newAmount.comparedTo(input.currentAmount)
  const direction: ProrationDirection =
    comparison > 0 ? 'upgrade' : comparison < 0 ? 'downgrade' : 'none'

  return {
    direction,
    periodMs,
    remainingMs,
    credit,
    charge,
    netAmount: charge.minus(credit),
  }
}
