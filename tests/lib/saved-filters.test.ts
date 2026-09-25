import { describe, it, expect } from 'vitest'
import {
  INVOICE_FILTER_FIELDS,
  MAX_FILTER_CONDITIONS,
  buildInvoiceWhere,
  parseInvoiceFilterDefinition,
  type InvoiceFilterDefinition,
} from '@/lib/saved-filters'

function parse(conditions: unknown[], extra: Record<string, unknown> = {}) {
  return parseInvoiceFilterDefinition({ conditions, ...extra })
}

function expectValid(conditions: unknown[], extra: Record<string, unknown> = {}): InvoiceFilterDefinition {
  const result = parse(conditions, extra)
  if (!result.success) throw new Error(`expected valid, got: ${result.errors.join('; ')}`)
  return result.definition
}

function expectInvalid(input: unknown): string[] {
  const result = parseInvoiceFilterDefinition(input)
  if (result.success) throw new Error('expected definition to be rejected')
  return result.errors
}

function whereFor(condition: unknown, match: 'all' | 'any' = 'all') {
  return buildInvoiceWhere(expectValid([condition], { match }), 'user-1')
}

function clauseFor(condition: unknown) {
  const where = whereFor(condition) as { AND: [unknown, { AND: unknown[] }] }
  return where.AND[1].AND[0]
}

describe('parseInvoiceFilterDefinition', () => {
  it('accepts a valid definition and defaults match to "all"', () => {
    const definition = expectValid([{ field: 'status', operator: 'eq', value: 'pending' }])
    expect(definition).toEqual({
      match: 'all',
      conditions: [{ field: 'status', operator: 'eq', value: 'pending' }],
    })
  })

  it('rejects non-object and malformed definitions', () => {
    expectInvalid(null)
    expectInvalid('status = pending')
    expectInvalid([])
    expectInvalid({})
    expectInvalid({ conditions: [] })
    expectInvalid({ conditions: 'status' })
    expectInvalid({ conditions: [{ field: 'status' }] })
    expectInvalid({ match: 'none', conditions: [{ field: 'status', operator: 'eq', value: 'paid' }] })
  })

  it('rejects more than the maximum number of conditions', () => {
    const conditions = Array.from({ length: MAX_FILTER_CONDITIONS + 1 }, () => ({
      field: 'status',
      operator: 'eq',
      value: 'paid',
    }))
    expectInvalid({ conditions })
  })

  it('rejects unknown fields, including prototype keys and non-filterable columns', () => {
    for (const field of ['userId', 'encryptedPayload', 'paymentLink', '__proto__', 'constructor', 'toString', 'user.email']) {
      const errors = expectInvalid({ conditions: [{ field, operator: 'eq', value: 'x' }] })
      expect(errors[0]).toContain('is not a filterable invoice field')
    }
  })

  it('rejects unknown operators, including raw Prisma operator names', () => {
    for (const operator of ['equals', 'not', 'OR', 'AND', 'search', 'mode', '$queryRaw', 'like']) {
      const errors = expectInvalid({ conditions: [{ field: 'status', operator, value: 'paid' }] })
      expect(errors[0]).toContain('is not a supported operator')
    }
  })

  it('rejects operators that do not apply to the field type', () => {
    expectInvalid({ conditions: [{ field: 'amount', operator: 'contains', value: 1 }] })
    expectInvalid({ conditions: [{ field: 'status', operator: 'gt', value: 'paid' }] })
    expectInvalid({ conditions: [{ field: 'dueDate', operator: 'eq', value: '2026-01-01' }] })
    expectInvalid({ conditions: [{ field: 'escrowEnabled', operator: 'neq', value: true }] })
    expectInvalid({ conditions: [{ field: 'status', operator: 'isNull' }] })
  })

  it('rejects unexpected properties on the definition and on conditions', () => {
    expectInvalid({ conditions: [{ field: 'status', operator: 'eq', value: 'paid' }], raw: 'SELECT 1' })
    expectInvalid({ conditions: [{ field: 'status', operator: 'eq', value: 'paid', mode: 'insensitive' }] })
    expectInvalid({ conditions: [{ field: 'status', operator: 'eq', value: 'paid', OR: [{ userId: 'x' }] }] })
  })

  it('rejects value type confusion', () => {
    expectInvalid({ conditions: [{ field: 'status', operator: 'eq', value: { not: 'paid' } }] })
    expectInvalid({ conditions: [{ field: 'status', operator: 'eq', value: ['paid'] }] })
    expectInvalid({ conditions: [{ field: 'status', operator: 'eq', value: '' }] })
    expectInvalid({ conditions: [{ field: 'status', operator: 'in', value: 'paid' }] })
    expectInvalid({ conditions: [{ field: 'status', operator: 'in', value: [] }] })
    expectInvalid({ conditions: [{ field: 'status', operator: 'in', value: ['paid', 1] }] })
    expectInvalid({ conditions: [{ field: 'amount', operator: 'gt', value: '100' }] })
    expectInvalid({ conditions: [{ field: 'amount', operator: 'gt', value: Number.POSITIVE_INFINITY }] })
    expectInvalid({ conditions: [{ field: 'amount', operator: 'gt', value: 1e12 }] })
    expectInvalid({ conditions: [{ field: 'dueDate', operator: 'gt', value: 'yesterday' }] })
    expectInvalid({ conditions: [{ field: 'dueDate', operator: 'gt', value: '2026-13-45' }] })
    expectInvalid({ conditions: [{ field: 'dueDate', operator: 'gt', value: 1700000000000 }] })
    expectInvalid({ conditions: [{ field: 'escrowEnabled', operator: 'eq', value: 'true' }] })
    expectInvalid({ conditions: [{ field: 'clientName', operator: 'isNull', value: null }] })
    expectInvalid({ conditions: [{ field: 'description', operator: 'contains', value: 'x'.repeat(256) }] })
  })

  it('treats SQL-looking strings as plain values', () => {
    const definition = expectValid([{ field: 'clientName', operator: 'eq', value: "x'; DROP TABLE \"Invoice\"; --" }])
    const where = buildInvoiceWhere(definition, 'user-1')
    expect(where).toEqual({
      AND: [
        { userId: 'user-1' },
        { AND: [{ clientName: { equals: "x'; DROP TABLE \"Invoice\"; --", mode: 'insensitive' } }] },
      ],
    })
  })
})

describe('buildInvoiceWhere', () => {
  it('always scopes to the owner in an outer AND, even for "any" matches', () => {
    const where = buildInvoiceWhere(
      expectValid(
        [
          { field: 'status', operator: 'eq', value: 'paid' },
          { field: 'currency', operator: 'eq', value: 'USD' },
        ],
        { match: 'any' },
      ),
      'user-1',
    )
    expect(where).toEqual({
      AND: [
        { userId: 'user-1' },
        { OR: [{ status: { equals: 'paid' } }, { currency: { equals: 'USD' } }] },
      ],
    })
  })

  it('translates keyword operators', () => {
    expect(clauseFor({ field: 'status', operator: 'eq', value: 'paid' })).toEqual({ status: { equals: 'paid' } })
    expect(clauseFor({ field: 'status', operator: 'neq', value: 'paid' })).toEqual({ status: { not: 'paid' } })
    expect(clauseFor({ field: 'currency', operator: 'in', value: ['USD', 'NGN'] })).toEqual({
      currency: { in: ['USD', 'NGN'] },
    })
    expect(clauseFor({ field: 'escrowStatus', operator: 'notIn', value: ['none'] })).toEqual({
      escrowStatus: { notIn: ['none'] },
    })
  })

  it('translates text operators case-insensitively', () => {
    expect(clauseFor({ field: 'clientEmail', operator: 'eq', value: 'a@b.co' })).toEqual({
      clientEmail: { equals: 'a@b.co', mode: 'insensitive' },
    })
    expect(clauseFor({ field: 'invoiceNumber', operator: 'neq', value: 'INV-1' })).toEqual({
      invoiceNumber: { not: 'INV-1', mode: 'insensitive' },
    })
    expect(clauseFor({ field: 'description', operator: 'contains', value: 'design' })).toEqual({
      description: { contains: 'design', mode: 'insensitive' },
    })
    expect(clauseFor({ field: 'clientName', operator: 'startsWith', value: 'Ac' })).toEqual({
      clientName: { startsWith: 'Ac', mode: 'insensitive' },
    })
    expect(clauseFor({ field: 'clientEmail', operator: 'endsWith', value: '@acme.io' })).toEqual({
      clientEmail: { endsWith: '@acme.io', mode: 'insensitive' },
    })
  })

  it('translates numeric comparison operators', () => {
    expect(clauseFor({ field: 'amount', operator: 'eq', value: 100 })).toEqual({ amount: { equals: 100 } })
    expect(clauseFor({ field: 'amount', operator: 'neq', value: 100 })).toEqual({ amount: { not: 100 } })
    expect(clauseFor({ field: 'amount', operator: 'gt', value: 100 })).toEqual({ amount: { gt: 100 } })
    expect(clauseFor({ field: 'amount', operator: 'gte', value: 100.5 })).toEqual({ amount: { gte: 100.5 } })
    expect(clauseFor({ field: 'amount', operator: 'lt', value: 0 })).toEqual({ amount: { lt: 0 } })
    expect(clauseFor({ field: 'amount', operator: 'lte', value: 99 })).toEqual({ amount: { lte: 99 } })
  })

  it('translates date operators into Date objects', () => {
    expect(clauseFor({ field: 'dueDate', operator: 'lt', value: '2026-10-01' })).toEqual({
      dueDate: { lt: new Date('2026-10-01') },
    })
    expect(clauseFor({ field: 'createdAt', operator: 'gte', value: '2026-09-01T00:00:00Z' })).toEqual({
      createdAt: { gte: new Date('2026-09-01T00:00:00Z') },
    })
    expect(clauseFor({ field: 'paidAt', operator: 'gt', value: '2026-09-01T08:30:00+01:00' })).toEqual({
      paidAt: { gt: new Date('2026-09-01T07:30:00Z') },
    })
    expect(clauseFor({ field: 'paidAt', operator: 'lte', value: '2026-09-30' })).toEqual({
      paidAt: { lte: new Date('2026-09-30') },
    })
  })

  it('translates null checks on nullable fields', () => {
    expect(clauseFor({ field: 'paidAt', operator: 'isNull' })).toEqual({ paidAt: null })
    expect(clauseFor({ field: 'dueDate', operator: 'isNotNull' })).toEqual({ dueDate: { not: null } })
    expect(clauseFor({ field: 'clientName', operator: 'isNull' })).toEqual({ clientName: null })
  })

  it('translates boolean equality', () => {
    expect(clauseFor({ field: 'escrowEnabled', operator: 'eq', value: true })).toEqual({
      escrowEnabled: { equals: true },
    })
  })

  it('covers every allowlisted field', () => {
    const sample: Record<string, unknown> = {
      status: { operator: 'eq', value: 'paid' },
      currency: { operator: 'eq', value: 'USD' },
      escrowStatus: { operator: 'eq', value: 'none' },
      amount: { operator: 'gt', value: 1 },
      invoiceNumber: { operator: 'eq', value: 'INV-1' },
      clientEmail: { operator: 'contains', value: 'acme' },
      clientName: { operator: 'isNotNull' },
      description: { operator: 'contains', value: 'logo' },
      dueDate: { operator: 'lt', value: '2026-10-01' },
      paidAt: { operator: 'isNull' },
      createdAt: { operator: 'gte', value: '2026-01-01' },
      escrowEnabled: { operator: 'eq', value: false },
    }
    expect(Object.keys(sample).sort()).toEqual(Object.keys(INVOICE_FILTER_FIELDS).sort())
    for (const [field, rest] of Object.entries(sample)) {
      const clause = clauseFor({ field, ...(rest as object) }) as Record<string, unknown>
      expect(Object.keys(clause)).toEqual([field])
    }
  })

  it('never emits keys that are not allowlisted columns or known Prisma filters', () => {
    const allowedKeys = new Set([
      'AND', 'OR', 'userId',
      ...Object.keys(INVOICE_FILTER_FIELDS),
      'equals', 'not', 'gt', 'gte', 'lt', 'lte', 'in', 'notIn', 'contains', 'startsWith', 'endsWith', 'mode',
    ])
    const where = buildInvoiceWhere(
      expectValid([
        { field: 'status', operator: 'in', value: ['paid'] },
        { field: 'clientName', operator: 'contains', value: '{"OR":[{"userId":"other"}]}' },
        { field: 'amount', operator: 'lte', value: 10 },
        { field: 'dueDate', operator: 'isNotNull' },
      ]),
      'user-1',
    )
    const visit = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(visit)
      if (node && typeof node === 'object' && !(node instanceof Date)) {
        for (const [key, value] of Object.entries(node)) {
          expect(allowedKeys.has(key)).toBe(true)
          visit(value)
        }
      }
    }
    visit(where)
  })
})
