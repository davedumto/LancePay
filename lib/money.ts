import { Decimal } from '@prisma/client/runtime/library'

// Monetary columns are DECIMAL(10,2): two fractional digits, at most
// 99,999,999.99. All arithmetic stays in Decimal; values are only converted
// to JS numbers when serialized into a response.
export const MONEY_SCALE = 2
export const MAX_MONEY_AMOUNT = new Decimal('99999999.99')

const MONEY_PATTERN = /^\d+(\.\d{1,2})?$/

/**
 * Parses a client-supplied positive monetary amount (number or numeric string)
 * into a Decimal. Returns null for anything that is not a positive amount with
 * at most two decimal places that fits the column.
 */
export function parsePositiveMoney(value: unknown): Decimal | null {
  let raw: string
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    raw = String(value)
  } else if (typeof value === 'string') {
    raw = value.trim()
  } else {
    return null
  }

  if (!MONEY_PATTERN.test(raw)) return null

  const amount = new Decimal(raw)
  if (amount.lte(0) || amount.gt(MAX_MONEY_AMOUNT)) return null
  return amount
}

/**
 * Rounds to cents, half away from zero. For non-negative amounts this is the
 * same result as the Math.round(x * 100) / 100 used elsewhere in billing.
 */
export function roundMoney(value: Decimal): Decimal {
  return value.toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_UP)
}
