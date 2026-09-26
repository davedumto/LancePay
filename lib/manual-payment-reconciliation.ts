import { Decimal } from '@prisma/client/runtime/library'

// Tolerances for matching a ManualPayment against a BankStatementLine. Bank
// charges and rounding can shave a little off the credited amount, and a
// transfer can post a few days after the client reports it, so an exact
// match is not required. Both are configurable through the environment.

const DEFAULT_AMOUNT_TOLERANCE = '1.00'
const DEFAULT_DATE_TOLERANCE_DAYS = 3
const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/
const MS_PER_DAY = 86_400_000

export interface ReconciliationTolerance {
  /** Maximum absolute difference, in the payment currency. */
  amount: Decimal
  /** Maximum number of calendar days between the payment and the bank line. */
  days: number
}

export function getReconciliationTolerance(env: NodeJS.ProcessEnv = process.env): ReconciliationTolerance {
  const rawAmount = env.MANUAL_PAYMENT_RECONCILE_AMOUNT_TOLERANCE?.trim()
  const rawDays = env.MANUAL_PAYMENT_RECONCILE_DATE_TOLERANCE_DAYS?.trim()
  return {
    amount: new Decimal(rawAmount && AMOUNT_PATTERN.test(rawAmount) ? rawAmount : DEFAULT_AMOUNT_TOLERANCE),
    days: rawDays && /^\d+$/.test(rawDays) ? Number(rawDays) : DEFAULT_DATE_TOLERANCE_DAYS,
  }
}

/**
 * Calendar date (YYYY-MM-DD) of an instant in the given IANA time zone,
 * falling back to UTC when the zone is missing or unknown.
 */
export function calendarDate(instant: Date, timeZone?: string | null): string {
  if (timeZone) {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(instant)
    } catch {
      // Unknown time zone: use UTC below.
    }
  }
  return instant.toISOString().slice(0, 10)
}

/** Whole calendar days between two YYYY-MM-DD dates, ignoring order. */
export function calendarDaysApart(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / MS_PER_DAY
}
