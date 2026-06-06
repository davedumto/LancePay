/**
 * Shared withdrawal fee logic for routes-b.
 * Used by both POST /withdrawals (real) and GET /withdrawals/estimate (preview).
 */

// Supported currencies for withdrawal
export const SUPPORTED_CURRENCIES = ['USDC', 'USD'] as const
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number]

// Fee rate: 1.5% flat
const FEE_RATE = 0.015

// Minimum fee in currency units
const MIN_FEE = 0.5

// Estimated arrival window in business days
const ESTIMATED_ARRIVAL_DAYS = 1

export interface FeeEstimate {
  fee: number
  feeCurrency: string
  netAmount: number
  estimatedArrival: string
}

export function isSupportedCurrency(currency: string): currency is SupportedCurrency {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(currency.toUpperCase())
}

/**
 * Calculate withdrawal fee for a given amount and currency.
 * Returns fee, feeCurrency, netAmount, and estimatedArrival.
 */
export function calculateWithdrawalFee(amount: number, currency: string): FeeEstimate {
  const normalizedCurrency = currency.toUpperCase()
  const fee = Math.max(MIN_FEE, parseFloat((amount * FEE_RATE).toFixed(2)))
  const netAmount = parseFloat((amount - fee).toFixed(2))

  const arrival = new Date()
  arrival.setDate(arrival.getDate() + ESTIMATED_ARRIVAL_DAYS)
  // Skip weekends
  if (arrival.getDay() === 6) arrival.setDate(arrival.getDate() + 2)
  if (arrival.getDay() === 0) arrival.setDate(arrival.getDate() + 1)

  return {
    fee,
    feeCurrency: normalizedCurrency,
    netAmount,
    estimatedArrival: arrival.toISOString().split('T')[0],
  }
}
