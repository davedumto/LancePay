import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

function resolveCurrency(
  currency: string,
  locale: string,
): { locale: string; currency: string; fractionDigits: number } {
  try {
    // Intl derives the correct fraction digits for the currency (USD/NGN=2,
    // JPY=0, etc.) — do not hardcode them per call site.
    const fractionDigits = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
    }).resolvedOptions().maximumFractionDigits
    return { locale, currency, fractionDigits }
  } catch {
    throw new Error(`Invalid currency code: "${currency}"`)
  }
}

export function formatCurrency(
  amount: number,
  currency = 'USD',
  locale = 'en-US',
) {
  const { locale: resolvedLocale, currency: code, fractionDigits } =
    resolveCurrency(currency, locale)
  return new Intl.NumberFormat(resolvedLocale, {
    style: 'currency',
    currency: code,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(amount)
}

export interface FormatNairaOptions {
  locale?: string
  /**
   * Show kobo (the currency's full fraction digits) instead of rounding to
   * whole naira. Withdrawal confirmations and any amount that feeds fee
   * math must pass `exact: true`.
   */
  exact?: boolean
}

export function formatNaira(amount: number, options: FormatNairaOptions = {}) {
  const locale = options.locale ?? 'en-NG'
  if (options.exact) {
    return formatCurrency(amount, 'NGN', locale)
  }
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'NGN',
    maximumFractionDigits: 0,
  }).format(amount)
}

/**
 * Invoice number format: `INV-<BASE36 ms timestamp>-<8 uppercase hex chars>`.
 *
 * The random part comes from `crypto.getRandomValues` (4 bytes, CSPRNG) —
 * never `Math.random` — because `Invoice.invoiceNumber` has a unique
 * constraint and payment webhooks look invoices up by this value. A
 * collision surfaces as a Prisma P2002 error; use `withInvoiceNumberRetry`
 * around invoice creation so a collision regenerates the number instead of
 * failing the request.
 */
export function generateInvoiceNumber() {
  const ts = Date.now().toString(36).toUpperCase()
  const bytes = new Uint8Array(4)
  globalThis.crypto.getRandomValues(bytes)
  const rand = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
  return `INV-${ts}-${rand}`
}

/** Maximum number of invoice-number generation attempts per create call. */
export const INVOICE_NUMBER_MAX_ATTEMPTS = 5

/**
 * Returns true when `error` is a Prisma unique-constraint violation (P2002)
 * on the invoiceNumber field. P2002 errors without target metadata are
 * treated as invoice-number collisions so callers still retry.
 */
export function isInvoiceNumberCollision(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const prismaError = error as { code?: unknown; meta?: { target?: unknown } }
  if (prismaError.code !== 'P2002') return false
  const target = prismaError.meta?.target
  if (typeof target === 'string') {
    return target.toLowerCase() === 'invoicenumber'
  }
  if (Array.isArray(target) && target.length > 0) {
    return target.some((field) => String(field).toLowerCase() === 'invoicenumber')
  }
  return true
}

/**
 * Runs `create` with a freshly generated invoice number, retrying on
 * invoice-number unique-constraint collisions up to `maxAttempts` times.
 * Any other error is rethrown immediately.
 */
export async function withInvoiceNumberRetry<T>(
  create: (invoiceNumber: string) => Promise<T>,
  maxAttempts: number = INVOICE_NUMBER_MAX_ATTEMPTS,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await create(generateInvoiceNumber())
    } catch (error) {
      if (!isInvoiceNumberCollision(error)) throw error
      lastError = error
    }
  }
  throw lastError
}
