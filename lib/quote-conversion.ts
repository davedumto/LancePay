// Business rules deciding whether a quote can still be converted into an
// invoice. Every failing rule is reported, so callers can show the full list
// of problems instead of fixing them one at a time.

export type QuoteIneligibilityCode =
  | 'QUOTE_EXPIRED'
  | 'QUOTE_ALREADY_CONVERTED'
  | 'QUOTE_DECLINED'
  | 'PRODUCT_DELETED'
  | 'PRODUCT_INACTIVE'

export interface QuoteIneligibilityReason {
  code: QuoteIneligibilityCode
  message: string
  lineItemId?: string
  productId?: string
}

export interface QuoteForEligibility {
  status: string
  expiresAt: Date | null
  invoiceId: string | null
  lineItems: { id: string; productId: string | null }[]
}

export interface ProductForEligibility {
  id: string
  isActive: boolean
}

const DECLINED_STATUSES = new Set(['declined', 'rejected'])

/**
 * Product ids referenced by the quote's line items, de-duplicated.
 */
export function referencedProductIds(quote: QuoteForEligibility): string[] {
  const ids = new Set<string>()
  for (const item of quote.lineItems) {
    if (item.productId) ids.add(item.productId)
  }
  return [...ids]
}

/**
 * Returns every reason the quote cannot be converted at `now`; an empty array
 * means it is eligible. `products` must contain the referenced products that
 * still exist for the quote owner — any referenced id absent from it is
 * reported as deleted.
 *
 * A quote is expired from its expiresAt instant onwards.
 */
export function evaluateQuoteConversionEligibility(
  quote: QuoteForEligibility,
  products: ProductForEligibility[],
  now: Date,
): QuoteIneligibilityReason[] {
  const reasons: QuoteIneligibilityReason[] = []

  if (quote.status === 'converted' || quote.invoiceId !== null) {
    reasons.push({
      code: 'QUOTE_ALREADY_CONVERTED',
      message: 'Quote has already been converted to an invoice',
    })
  }

  if (DECLINED_STATUSES.has(quote.status)) {
    reasons.push({
      code: 'QUOTE_DECLINED',
      message: `Quote was ${quote.status} by the client`,
    })
  }

  if (
    quote.status === 'expired' ||
    (quote.expiresAt !== null && now.getTime() >= quote.expiresAt.getTime())
  ) {
    reasons.push({
      code: 'QUOTE_EXPIRED',
      message: 'Quote has expired',
    })
  }

  const productsById = new Map(products.map((p) => [p.id, p]))
  for (const item of quote.lineItems) {
    if (!item.productId) continue

    const product = productsById.get(item.productId)
    if (!product) {
      reasons.push({
        code: 'PRODUCT_DELETED',
        message: 'A product referenced by this quote has been deleted',
        lineItemId: item.id,
        productId: item.productId,
      })
    } else if (!product.isActive) {
      reasons.push({
        code: 'PRODUCT_INACTIVE',
        message: 'A product referenced by this quote is no longer active',
        lineItemId: item.id,
        productId: item.productId,
      })
    }
  }

  return reasons
}
