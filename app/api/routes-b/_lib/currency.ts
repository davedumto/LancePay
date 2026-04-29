import { getCachedValue } from './cache'

export type ConversionResult = {
  amount: number
  currency: string
  normalized: boolean
}

/**
 * Normalizes an amount to USDC using cached exchange rates.
 * If the rate is unavailable, returns the original amount and currency with normalized: false.
 */
export function toUSDC(amount: number, currency: string): ConversionResult {
  const upperCurrency = currency.toUpperCase()
  
  if (upperCurrency === 'USDC' || upperCurrency === 'USD') {
    return {
      amount,
      currency: 'USDC',
      normalized: true,
    }
  }

  // The exchange-rate endpoint caches as exchange-rate:FROM:TO
  // To get USDC value from NGN, we need the rate for NGN -> USDC
  const cacheKey = `exchange-rate:${upperCurrency}:USDC`
  const cached = getCachedValue<{ value: number }>(cacheKey)

  if (cached && typeof cached.value === 'number') {
    return {
      amount: amount * cached.value, // Wait, usually rates are 1 FROM = X TO. 
      // If rate is NGN -> USDC, it's 1 NGN = 0.0006 USDC. So amount * rate.
      currency: 'USDC',
      normalized: true,
    }
  }

  return {
    amount,
    currency: upperCurrency,
    normalized: false,
  }
}

/**
 * Aggregates a list of groups (from Prisma groupBy) into either a single USDC total
 * or a map of totals per currency if normalization fails.
 */
export function aggregateGroups(
  groups: { currency: string; _sum: { amount: unknown } }[]
): number | Record<string, number> {
  const totals: Record<string, number> = {}
  let allNormalized = true
  let usdcTotal = 0

  for (const group of groups) {
    const amount = Number(group._sum.amount ?? 0)
    const converted = toUSDC(amount, group.currency)
    
    if (converted.normalized) {
      usdcTotal += converted.amount
    } else {
      allNormalized = false
      const cur = converted.currency.toUpperCase()
      totals[cur] = (totals[cur] ?? 0) + converted.amount
    }
  }

  if (allNormalized) {
    return Number(usdcTotal.toFixed(2))
  }

  // If any couldn't be normalized, we return the per-currency breakdown.
  // We include the USDC total we did manage to get.
  if (usdcTotal > 0) {
    totals['USDC'] = (totals['USDC'] ?? 0) + Number(usdcTotal.toFixed(2))
  }

  return totals
}
