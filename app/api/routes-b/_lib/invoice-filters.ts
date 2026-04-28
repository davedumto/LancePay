import { Prisma } from '@prisma/client'

export type InvoiceListFilters = {
  number: string | null
  client: string | null
  minAmount: string | null
  maxAmount: string | null
  currency: string | null
}

export function parsePositiveAmount(value: string | null): number | null {
  if (value === null) return null

  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('Amount filters must be positive numbers')
  }

  return parsed
}

export function buildInvoiceWhereFilters(filters: InvoiceListFilters): Prisma.InvoiceWhereInput {
  const where: Prisma.InvoiceWhereInput = {}

  if (filters.number) {
    where.invoiceNumber = { contains: filters.number, mode: 'insensitive' }
  }

  if (filters.client) {
    where.clientName = { contains: filters.client, mode: 'insensitive' }
  }

  const minAmount = parsePositiveAmount(filters.minAmount)
  const maxAmount = parsePositiveAmount(filters.maxAmount)

  if (minAmount !== null || maxAmount !== null) {
    if (minAmount !== null && maxAmount !== null && minAmount > maxAmount) {
      throw new Error('minAmount must be less than or equal to maxAmount')
    }

    where.amount = {
      ...(minAmount !== null ? { gte: minAmount } : {}),
      ...(maxAmount !== null ? { lte: maxAmount } : {}),
    }
  }

  if (filters.currency) {
    where.currency = filters.currency.toUpperCase()
  }

  return where
}
