export const SUPPORTED_INVOICE_CURRENCIES = ['USD'] as const

export type SupportedInvoiceCurrency = (typeof SUPPORTED_INVOICE_CURRENCIES)[number]

export function normalizeInvoiceCurrency(currency: unknown): SupportedInvoiceCurrency | null {
  if (typeof currency !== 'string') return null
  const upper = currency.trim().toUpperCase()
  return (SUPPORTED_INVOICE_CURRENCIES as readonly string[]).includes(upper)
    ? (upper as SupportedInvoiceCurrency)
    : null
}
