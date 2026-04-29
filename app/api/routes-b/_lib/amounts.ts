/**
 * Safely converts a raw DB value (Decimal, bigint, string, number, null) to a
 * plain JavaScript number suitable for JSON serialization.
 */
export function normalizeCurrencyAmount(raw: unknown): number {
  if (raw === null || raw === undefined) return 0
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0
  if (typeof raw === 'bigint') return Number(raw)
  const n = Number(raw)
  return Number.isFinite(n) ? n : 0
}
