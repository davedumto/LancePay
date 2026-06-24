/**
 * late-fee.ts — Issue #599
 *
 * Pure helper for computing late fees on overdue invoices.
 * Default policy: 1.5% flat per 30-day period overdue, capped at 10% of principal.
 * The helper is deterministic given inputs and has no side effects.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export interface InvoiceForLateFee {
  /** Principal amount in the smallest unit (e.g. cents). Numbers are accepted for simplicity. */
  amount: number;
  currency: string;
  /** ISO date string or Date instance — must be set for an invoice to be considered for late fees. */
  dueDate: Date | string | null;
}

export interface LateFeePolicy {
  /** Fee charged per period as a fraction (0.015 = 1.5%). */
  ratePerPeriod: number;
  /** Period length in days (default 30). */
  periodDays: number;
  /** Cap as a fraction of the principal (0.10 = 10%). */
  capFraction: number;
}

export const DEFAULT_LATE_FEE_POLICY: LateFeePolicy = {
  ratePerPeriod: 0.015, // 1.5%
  periodDays: 30,
  capFraction: 0.10, // 10%
};

export interface LateFeeResult {
  /** Computed fee amount in the same unit as the invoice principal. */
  amount: number;
  currency: string;
  /** Days the invoice is overdue (0 if not overdue). */
  daysLate: number;
  /** True when a non-zero fee was applied. */
  applied: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toDate(value: Date | string | null): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Compute the late fee for an invoice given a policy and an as-of date.
 *
 * Rules:
 *  - If the invoice has no dueDate or asOf <= dueDate → no fee, daysLate=0, applied=false
 *  - Otherwise: floor(daysLate / periodDays) periods × ratePerPeriod × principal
 *  - Result is capped at capFraction × principal
 *  - Currency is preserved from the invoice
 */
export function computeLateFee(
  invoice: InvoiceForLateFee,
  asOf: Date | string,
  policy: LateFeePolicy = DEFAULT_LATE_FEE_POLICY,
): LateFeeResult {
  const dueDate = toDate(invoice.dueDate);
  const asOfDate = toDate(asOf as Date | string);
  const principal = Math.max(0, invoice.amount);

  // Not overdue or missing data
  if (!dueDate || !asOfDate || asOfDate <= dueDate || principal === 0) {
    return {
      amount: 0,
      currency: invoice.currency,
      daysLate: 0,
      applied: false,
    };
  }

  const daysLate = Math.floor((asOfDate.getTime() - dueDate.getTime()) / MS_PER_DAY);
  const periodsLate = Math.floor(daysLate / Math.max(1, policy.periodDays));

  if (periodsLate <= 0) {
    return {
      amount: 0,
      currency: invoice.currency,
      daysLate,
      applied: false,
    };
  }

  const rawFee = principal * policy.ratePerPeriod * periodsLate;
  const cap = principal * policy.capFraction;
  const amount = Math.min(rawFee, cap);

  // Round to 2 decimal places for currency precision
  const rounded = Math.round(amount * 100) / 100;

  return {
    amount: rounded,
    currency: invoice.currency,
    daysLate,
    applied: rounded > 0,
  };
}
