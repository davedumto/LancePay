/**
 * KYC Review SLA Configuration
 *
 * Defines SLA windows and constants for KYC application reviews.
 * These values determine how urgent a pending KYC application is
 * based on time elapsed since submission.
 */

import { envNumber } from './env'

/**
 * SLA window for KYC application review (in milliseconds).
 * Applications are considered urgent based on proximity to this deadline.
 * Default: 5 days (5 * 24 * 60 * 60 * 1000 = 432,000,000 ms)
 *
 * Can be overridden via KYC_REVIEW_SLA_WINDOW_MS environment variable —
 * must be a positive integer count of milliseconds (e.g. "432000000").
 * Invalid values fall back to the default with a logged warning.
 */
export const KYC_REVIEW_SLA_WINDOW_MS = envNumber(
  'KYC_REVIEW_SLA_WINDOW_MS',
  5 * 24 * 60 * 60 * 1000,
  { integer: true },
)

/**
 * Pending status value for KYC applications.
 * Matches the Prisma schema default.
 */
export const KYC_STATUS_PENDING = 'pending'

/**
 * Calculates the SLA deadline (in milliseconds) for a given submission timestamp.
 * @param submittedAt - The submission timestamp
 * @returns The absolute deadline timestamp in milliseconds
 */
export function getKycSlaDeadline(submittedAt: Date): number {
  return submittedAt.getTime() + KYC_REVIEW_SLA_WINDOW_MS
}

/**
 * Calculates time remaining until SLA breach for a given submission timestamp.
 * Negative values indicate the application has already breached the SLA.
 *
 * @param submittedAt - The submission timestamp
 * @param now - Current timestamp (defaults to Date.now())
 * @returns Time remaining in milliseconds (can be negative)
 */
export function getTimeRemainingMs(submittedAt: Date, now: number = Date.now()): number {
  const deadline = getKycSlaDeadline(submittedAt)
  return deadline - now
}
