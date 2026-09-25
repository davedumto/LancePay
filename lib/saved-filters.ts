import { z } from 'zod'
import type { Prisma } from '@prisma/client'

/**
 * Saved invoice filters are stored as structured JSON:
 *
 *   { "match": "all" | "any", "conditions": [{ "field", "operator", "value" }] }
 *
 * Fields and operators come from fixed allowlists below. The stored JSON is
 * never handed to Prisma directly: every condition is re-validated and
 * rebuilt into a Prisma where clause by `buildInvoiceWhere`, which only emits
 * keys it knows about. Values reach the database as bound parameters.
 */

export const SAVED_FILTER_ENTITY_INVOICE = 'invoice'
export const MAX_FILTER_CONDITIONS = 20
const MAX_IN_VALUES = 50
const MAX_TEXT_LENGTH = 255
// Invoice.amount is Decimal(10, 2).
const MAX_AMOUNT = 99_999_999.99

export const FILTER_OPERATORS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'notIn',
  'contains',
  'startsWith',
  'endsWith',
  'isNull',
  'isNotNull',
] as const
export type FilterOperator = (typeof FILTER_OPERATORS)[number]

type FieldKind = 'keyword' | 'text' | 'number' | 'date' | 'boolean'

type FieldSpec = {
  kind: FieldKind
  nullable: boolean
}

const KIND_OPERATORS: Record<FieldKind, readonly FilterOperator[]> = {
  keyword: ['eq', 'neq', 'in', 'notIn'],
  text: ['eq', 'neq', 'contains', 'startsWith', 'endsWith'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'],
  date: ['gt', 'gte', 'lt', 'lte'],
  boolean: ['eq'],
}

/** Invoice columns a saved filter may reference. Keys are real Invoice fields. */
export const INVOICE_FILTER_FIELDS = {
  status: { kind: 'keyword', nullable: false },
  currency: { kind: 'keyword', nullable: false },
  escrowStatus: { kind: 'keyword', nullable: false },
  amount: { kind: 'number', nullable: false },
  invoiceNumber: { kind: 'text', nullable: false },
  clientEmail: { kind: 'text', nullable: false },
  clientName: { kind: 'text', nullable: true },
  description: { kind: 'text', nullable: false },
  dueDate: { kind: 'date', nullable: true },
  paidAt: { kind: 'date', nullable: true },
  createdAt: { kind: 'date', nullable: false },
  escrowEnabled: { kind: 'boolean', nullable: false },
} as const satisfies Record<string, FieldSpec>

export type InvoiceFilterField = keyof typeof INVOICE_FILTER_FIELDS

export type FilterCondition = {
  field: InvoiceFilterField
  operator: FilterOperator
  /** Absent only for isNull / isNotNull. */
  value?: FilterValue
}

type FilterValue = string | number | boolean | string[]

export type InvoiceFilterDefinition = {
  match: 'all' | 'any'
  conditions: FilterCondition[]
}

const rawConditionSchema = z
  .object({
    field: z.string(),
    operator: z.string(),
    value: z.unknown().optional(),
  })
  .strict()

const rawDefinitionSchema = z
  .object({
    match: z.enum(['all', 'any']).default('all'),
    conditions: z.array(rawConditionSchema).min(1).max(MAX_FILTER_CONDITIONS),
  })
  .strict()

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/

function isFilterField(field: string): field is InvoiceFilterField {
  return Object.prototype.hasOwnProperty.call(INVOICE_FILTER_FIELDS, field)
}

function isFilterOperator(operator: string): operator is FilterOperator {
  return (FILTER_OPERATORS as readonly string[]).includes(operator)
}

function isValidText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_TEXT_LENGTH
}

function isValidDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (!ISO_DATE.test(value) && !ISO_DATETIME.test(value)) return false
  return !Number.isNaN(new Date(value).getTime())
}

function validateValue(kind: FieldKind, operator: FilterOperator, value: unknown): string | null {
  if (operator === 'in' || operator === 'notIn') {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_IN_VALUES) {
      return `value must be an array of 1-${MAX_IN_VALUES} strings`
    }
    return value.every(isValidText) ? null : 'every value must be a non-empty string'
  }

  switch (kind) {
    case 'keyword':
    case 'text':
      return isValidText(value) ? null : `value must be a non-empty string of at most ${MAX_TEXT_LENGTH} characters`
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_AMOUNT
        ? null
        : 'value must be a finite number'
    case 'date':
      return isValidDate(value) ? null : 'value must be an ISO 8601 date or date-time'
    case 'boolean':
      return typeof value === 'boolean' ? null : 'value must be a boolean'
  }
}

export type FilterValidationResult =
  | { success: true; definition: InvoiceFilterDefinition }
  | { success: false; errors: string[] }

/**
 * Validates an untrusted filter definition (request body or stored JSON)
 * against the field/operator allowlists and returns a normalized copy.
 */
export function parseInvoiceFilterDefinition(input: unknown): FilterValidationResult {
  const parsed = rawDefinitionSchema.safeParse(input)
  if (!parsed.success) {
    return {
      success: false,
      errors: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'definition'}: ${issue.message}`),
    }
  }

  const errors: string[] = []
  const conditions: FilterCondition[] = []

  parsed.data.conditions.forEach((condition, index) => {
    const at = `conditions.${index}`
    const { field, operator } = condition

    if (!isFilterField(field)) {
      errors.push(`${at}.field: '${field}' is not a filterable invoice field`)
      return
    }
    if (!isFilterOperator(operator)) {
      errors.push(`${at}.operator: '${operator}' is not a supported operator`)
      return
    }

    const spec: FieldSpec = INVOICE_FILTER_FIELDS[field]

    if (operator === 'isNull' || operator === 'isNotNull') {
      if (!spec.nullable) {
        errors.push(`${at}.operator: '${operator}' is not supported for '${field}'`)
        return
      }
      if (condition.value !== undefined) {
        errors.push(`${at}.value: '${operator}' does not take a value`)
        return
      }
      conditions.push({ field, operator })
      return
    }

    if (!KIND_OPERATORS[spec.kind].includes(operator)) {
      errors.push(`${at}.operator: '${operator}' is not supported for '${field}'`)
      return
    }

    const valueError = validateValue(spec.kind, operator, condition.value)
    if (valueError) {
      errors.push(`${at}.value: ${valueError}`)
      return
    }

    conditions.push({ field, operator, value: condition.value as FilterValue })
  })

  if (errors.length > 0) return { success: false, errors }
  return { success: true, definition: { match: parsed.data.match, conditions } }
}

type ScalarFilter = Record<string, unknown> | null

function toColumnFilter(kind: FieldKind, condition: FilterCondition): ScalarFilter {
  if (condition.operator === 'isNull') return null
  if (condition.operator === 'isNotNull') return { not: null }

  const value = kind === 'date' ? new Date(String(condition.value)) : condition.value
  const insensitive = kind === 'text' ? { mode: 'insensitive' as const } : {}

  switch (condition.operator) {
    case 'eq':
      return { equals: value, ...insensitive }
    case 'neq':
      return { not: value, ...insensitive }
    case 'gt':
      return { gt: value }
    case 'gte':
      return { gte: value }
    case 'lt':
      return { lt: value }
    case 'lte':
      return { lte: value }
    case 'in':
      return { in: value }
    case 'notIn':
      return { notIn: value }
    case 'contains':
      return { contains: value, ...insensitive }
    case 'startsWith':
      return { startsWith: value, ...insensitive }
    case 'endsWith':
      return { endsWith: value, ...insensitive }
  }
}

/**
 * Builds the Prisma where clause for a validated definition. The owner
 * scope is an outer AND, so an "any" match can never widen the result set
 * beyond the caller's own invoices.
 */
export function buildInvoiceWhere(
  definition: InvoiceFilterDefinition,
  ownerUserId: string,
): Prisma.InvoiceWhereInput {
  const clauses = definition.conditions.map(
    (condition) =>
      ({
        [condition.field]: toColumnFilter(INVOICE_FILTER_FIELDS[condition.field].kind, condition),
      }) as Prisma.InvoiceWhereInput,
  )

  return {
    AND: [{ userId: ownerUserId }, definition.match === 'any' ? { OR: clauses } : { AND: clauses }],
  }
}
