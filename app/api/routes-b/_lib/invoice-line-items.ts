import crypto from 'node:crypto'

export const MAX_ITEMS_PER_INVOICE = 50
export const MAX_NAME_LENGTH = 200

export type LineItem = {
  id: string
  name: string
  quantity: number
  unitPrice: number
  taxRate: number
  createdAt: string
  updatedAt: string
}

export type LineItemTotals = {
  subtotal: number
  taxTotal: number
  total: number
}

type NewItemInput = { name: string; quantity: number; unitPrice: number; taxRate: number }
type ItemPatch = Partial<NewItemInput>

export type ItemValidationResult =
  | { ok: true; value: NewItemInput }
  | { ok: false; error: string }

export type ItemPatchValidationResult =
  | { ok: true; value: ItemPatch }
  | { ok: false; error: string }

const itemStore = new Map<string, LineItem[]>()

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isValidTaxRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function isValidName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_NAME_LENGTH
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100
}

export function validateNewItem(body: unknown): ItemValidationResult {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Item body must be an object' }
  }
  const { name, quantity, unitPrice, taxRate } = body as Record<string, unknown>

  if (!isValidName(name)) {
    return { ok: false, error: `name must be a non-empty string (max ${MAX_NAME_LENGTH} chars)` }
  }
  if (!isPositiveInteger(quantity)) {
    return { ok: false, error: 'quantity must be a positive integer' }
  }
  if (!isPositiveNumber(unitPrice)) {
    return { ok: false, error: 'unitPrice must be a positive number' }
  }
  if (!isValidTaxRate(taxRate)) {
    return { ok: false, error: 'taxRate must be a number between 0 and 1' }
  }

  return {
    ok: true,
    value: { name: (name as string).trim(), quantity, unitPrice, taxRate },
  }
}

export function validateItemPatch(body: unknown): ItemPatchValidationResult {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Patch body must be an object' }
  }
  const { name, quantity, unitPrice, taxRate } = body as Record<string, unknown>
  const out: ItemPatch = {}

  if (name !== undefined) {
    if (!isValidName(name)) {
      return { ok: false, error: `name must be a non-empty string (max ${MAX_NAME_LENGTH} chars)` }
    }
    out.name = (name as string).trim()
  }
  if (quantity !== undefined) {
    if (!isPositiveInteger(quantity)) {
      return { ok: false, error: 'quantity must be a positive integer' }
    }
    out.quantity = quantity
  }
  if (unitPrice !== undefined) {
    if (!isPositiveNumber(unitPrice)) {
      return { ok: false, error: 'unitPrice must be a positive number' }
    }
    out.unitPrice = unitPrice
  }
  if (taxRate !== undefined) {
    if (!isValidTaxRate(taxRate)) {
      return { ok: false, error: 'taxRate must be a number between 0 and 1' }
    }
    out.taxRate = taxRate
  }

  if (Object.keys(out).length === 0) {
    return { ok: false, error: 'No fields to update' }
  }

  return { ok: true, value: out }
}

export function listLineItems(invoiceId: string): LineItem[] {
  const stored = itemStore.get(invoiceId)
  return stored ? stored.map(item => ({ ...item })) : []
}

export function getLineItem(invoiceId: string, itemId: string): LineItem | null {
  const stored = itemStore.get(invoiceId)
  if (!stored) return null
  const found = stored.find(item => item.id === itemId)
  return found ? { ...found } : null
}

export function computeTotals(items: LineItem[]): LineItemTotals {
  let subtotal = 0
  let taxTotal = 0
  for (const item of items) {
    const lineSubtotal = item.quantity * item.unitPrice
    subtotal += lineSubtotal
    taxTotal += lineSubtotal * item.taxRate
  }
  subtotal = roundCents(subtotal)
  taxTotal = roundCents(taxTotal)
  return {
    subtotal,
    taxTotal,
    total: roundCents(subtotal + taxTotal),
  }
}

export class InvoiceItemCapError extends Error {
  code = 'INVOICE_ITEM_CAP'
  constructor() {
    super(`An invoice can have at most ${MAX_ITEMS_PER_INVOICE} items`)
  }
}

export class LineItemNotFoundError extends Error {
  code = 'LINE_ITEM_NOT_FOUND'
  constructor() {
    super('Line item not found')
  }
}

type Plan<T> = { totals: LineItemTotals; commit: () => void } & T

export function planAddItem(invoiceId: string, input: NewItemInput): Plan<{ item: LineItem }> {
  const existing = itemStore.get(invoiceId) ?? []
  if (existing.length >= MAX_ITEMS_PER_INVOICE) {
    throw new InvoiceItemCapError()
  }

  const now = new Date().toISOString()
  const item: LineItem = {
    id: crypto.randomUUID(),
    name: input.name,
    quantity: input.quantity,
    unitPrice: input.unitPrice,
    taxRate: input.taxRate,
    createdAt: now,
    updatedAt: now,
  }
  const next = [...existing, item]
  const totals = computeTotals(next)

  return {
    item: { ...item },
    totals,
    commit: () => {
      itemStore.set(invoiceId, next)
    },
  }
}

export function planPatchItem(
  invoiceId: string,
  itemId: string,
  patch: ItemPatch,
): Plan<{ item: LineItem }> {
  const existing = itemStore.get(invoiceId)
  if (!existing) throw new LineItemNotFoundError()
  const idx = existing.findIndex(item => item.id === itemId)
  if (idx < 0) throw new LineItemNotFoundError()

  const updated: LineItem = {
    ...existing[idx],
    ...patch,
    updatedAt: new Date().toISOString(),
  }
  const next = existing.slice()
  next[idx] = updated
  const totals = computeTotals(next)

  return {
    item: { ...updated },
    totals,
    commit: () => {
      itemStore.set(invoiceId, next)
    },
  }
}

export function planRemoveItem(invoiceId: string, itemId: string): Plan<Record<string, never>> {
  const existing = itemStore.get(invoiceId)
  if (!existing) throw new LineItemNotFoundError()
  const idx = existing.findIndex(item => item.id === itemId)
  if (idx < 0) throw new LineItemNotFoundError()

  const next = existing.slice()
  next.splice(idx, 1)
  const totals = computeTotals(next)

  return {
    totals,
    commit: () => {
      if (next.length === 0) {
        itemStore.delete(invoiceId)
      } else {
        itemStore.set(invoiceId, next)
      }
    },
  }
}

export function resetInvoiceLineItemsStore(): void {
  itemStore.clear()
}
