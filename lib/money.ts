import { Decimal } from '@prisma/client/runtime/library'

// Monetary columns are DECIMAL(10,2): two fractional digits, at most
// 99,999,999.99. All arithmetic stays in Decimal; values are only converted
// to JS numbers when serialized into a response.
export const MONEY_SCALE = 2
export const MAX_MONEY_AMOUNT = new Decimal('99999999.99')

const MONEY_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/

export interface ParseMoneyOptions {
  allowZero?: boolean
  allowNegative?: boolean
}

/**
 * Parses a client-supplied monetary amount into a Decimal while preserving the
 * database column's scale and range constraints. Callers can explicitly allow
 * zero or signed values for flows such as credits and refunds.
 */
export function parseMoney(value: unknown, options: ParseMoneyOptions = {}): Decimal | null {
  let raw: string
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    raw = String(value)
  } else if (typeof value === 'string') {
    raw = value.trim()
  } else {
    return null
  }

  const isNegative = raw.startsWith('-')
  const unsignedRaw = isNegative ? raw.slice(1) : raw
  if (!MONEY_PATTERN.test(unsignedRaw)) return null
  if (isNegative && !options.allowNegative) return null

  const amount = new Decimal(raw)
  if (amount.isZero() && !options.allowZero) return null
  if (amount.abs().gt(MAX_MONEY_AMOUNT)) return null
  return amount
}

/**
 * Parses a client-supplied positive monetary amount (number or numeric string)
 * into a Decimal. Returns null for anything that is not a positive amount with
 * at most two decimal places that fits the column.
 */
export function parsePositiveMoney(value: unknown): Decimal | null {
  return parseMoney(value)
}

/**
 * Rounds to cents, half away from zero. For non-negative amounts this is the
 * same result as the Math.round(x * 100) / 100 used elsewhere in billing.
 */
export function roundMoney(value: Decimal): Decimal {
  return value.toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_UP)
}
