/**
 * Safely converts a raw DB value (Decimal, bigint, string, number, null/undefined)
 * into a finite JavaScript number suitable for JSON serialization.
 */
export function normalizeCurrencyAmount(value: unknown): number {
  if (value == null) return 0

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0
  }

  if (typeof value === 'bigint') {
    return Number(value)
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}