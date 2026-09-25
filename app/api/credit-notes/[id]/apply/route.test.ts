import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { Decimal } from '@prisma/client/runtime/library'

// In-memory stand-in for the tables this route touches. $transaction runs one
// callback at a time (like row locks on the same credit note) and restores the
// previous state if the callback throws, so tests observe real atomicity and
// the effect of the conditional updates the route relies on.

interface CreditNoteRow {
  id: string
  userId: string
  creditNumber: string
  amount: Decimal
  appliedAmount: Decimal
  currency: string
  status: string
  invoiceClientEmail: string
}

interface InvoiceRow {
  id: string
  userId: string
  amount: Decimal
  currency: string
  status: string
  clientEmail: string
  paidAt: Date | null
}

interface State {
  creditNotes: Map<string, CreditNoteRow>
  invoices: Map<string, InvoiceRow>
  applications: { id: string; creditNoteId: string; invoiceId: string; amount: Decimal }[]
}

const store = vi.hoisted(() => ({
  state: null as unknown as State,
  queue: Promise.resolve() as Promise<unknown>,
  beforeTransaction: null as null | (() => void),
  rawSql: [] as string[],
}))

function cloneState(state: State): State {
  return {
    creditNotes: new Map([...state.creditNotes].map(([k, v]) => [k, { ...v }])),
    invoices: new Map([...state.invoices].map(([k, v]) => [k, { ...v }])),
    applications: state.applications.map((a) => ({ ...a })),
  }
}

function matchesInvoiceWhere(inv: InvoiceRow, where: Record<string, unknown>): boolean {
  if (where.id !== undefined && inv.id !== where.id) return false
  if (where.userId !== undefined && inv.userId !== where.userId) return false
  if (where.currency !== undefined && inv.currency !== where.currency) return false
  const status = where.status as { in: string[] } | undefined
  if (status && !status.in.includes(inv.status)) return false
  const amount = where.amount as { gte: Decimal } | undefined
  if (amount && inv.amount.lt(amount.gte)) return false
  return true
}

const selectInvoice = (inv: InvoiceRow) => ({
  id: inv.id,
  amount: inv.amount,
  currency: inv.currency,
  status: inv.status,
  clientEmail: inv.clientEmail,
})

function makeTx() {
  return {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      store.rawSql.push(strings.join('?'))
      const total = values[0] as Decimal
      const id = values[3] as string
      const userId = values[4] as string
      const note = store.state.creditNotes.get(id)
      if (!note || note.userId !== userId || note.status !== 'issued') return []
      const next = note.appliedAmount.plus(total)
      if (next.gt(note.amount)) return []
      note.appliedAmount = next
      if (next.eq(note.amount)) note.status = 'applied'
      return [{ amount: note.amount, appliedAmount: note.appliedAmount, status: note.status }]
    }),
    invoice: {
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: { amount: { decrement: Decimal } } }) => {
        const inv = store.state.invoices.get(where.id as string)
        if (!inv || !matchesInvoiceWhere(inv, where)) return { count: 0 }
        inv.amount = inv.amount.minus(data.amount.decrement)
        return { count: 1 }
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
        const inv = store.state.invoices.get(where.id)
        if (!inv) throw new Error('not found')
        return { amount: inv.amount, status: inv.status }
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { status: string; paidAt: Date } }) => {
        const inv = store.state.invoices.get(where.id)!
        inv.status = data.status
        inv.paidAt = data.paidAt
        return { amount: inv.amount, status: inv.status }
      }),
    },
    creditNoteApplication: {
      create: vi.fn(async ({ data }: { data: { creditNoteId: string; invoiceId: string; amount: Decimal } }) => {
        const row = { id: `app-${store.state.applications.length + 1}`, ...data }
        store.state.applications.push(row)
        return { id: row.id }
      }),
    },
  }
}

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    creditNote: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; userId: string } }) => {
        const note = store.state.creditNotes.get(where.id)
        if (!note || note.userId !== where.userId) return null
        return {
          id: note.id,
          creditNumber: note.creditNumber,
          amount: note.amount,
          appliedAmount: note.appliedAmount,
          currency: note.currency,
          status: note.status,
          invoice: { clientEmail: note.invoiceClientEmail },
        }
      }),
    },
    invoice: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] }; userId: string } }) =>
        where.id.in
          .map((id) => store.state.invoices.get(id))
          .filter((inv): inv is InvoiceRow => !!inv && inv.userId === where.userId)
          .map(selectInvoice),
      ),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const run = store.queue.then(async () => {
        store.beforeTransaction?.()
        const snapshot = cloneState(store.state)
        try {
          return await fn(makeTx())
        } catch (error) {
          store.state = snapshot
          throw error
        }
      })
      store.queue = run.catch(() => undefined)
      return run
    }),
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
  extractRequestMetadata: vi.fn(() => ({})),
}))

import { POST } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'

const d = (v: string) => new Decimal(v)

function seed({
  note = {},
  invoices = [],
}: {
  note?: Partial<CreditNoteRow>
  invoices?: Partial<InvoiceRow>[]
} = {}) {
  const creditNote: CreditNoteRow = {
    id: 'cn-1',
    userId: 'user-1',
    creditNumber: 'CN-1',
    amount: d('100.00'),
    appliedAmount: d('0'),
    currency: 'USD',
    status: 'issued',
    invoiceClientEmail: 'client@example.com',
    ...note,
  }
  store.state = {
    creditNotes: new Map([[creditNote.id, creditNote]]),
    invoices: new Map(
      invoices.map((inv, i) => {
        const row: InvoiceRow = {
          id: `inv-${i + 1}`,
          userId: 'user-1',
          amount: d('100.00'),
          currency: 'USD',
          status: 'pending',
          clientEmail: 'client@example.com',
          paidAt: null,
          ...inv,
        }
        return [row.id, row]
      }),
    ),
    applications: [],
  }
}

function makeRequest(body: unknown, token: string | null = 'token') {
  return new NextRequest('http://localhost/api/credit-notes/cn-1/apply', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function call(body: unknown, { token = 'token' as string | null, id = 'cn-1' } = {}) {
  const res = await POST(makeRequest(body, token), { params: Promise.resolve({ id }) })
  return { res, body: await res.json() }
}

const note = () => store.state.creditNotes.get('cn-1')!
const invoice = (id: string) => store.state.invoices.get(id)!

beforeEach(() => {
  vi.clearAllMocks()
  store.queue = Promise.resolve()
  store.beforeTransaction = null
  store.rawSql = []
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' } as never)
  seed({ invoices: [{}, {}] })
})

describe('POST /api/credit-notes/[id]/apply', () => {
  describe('authentication and ownership', () => {
    it('returns 401 without a token and never opens a transaction', async () => {
      const { res } = await call({ allocations: [{ invoiceId: 'inv-1', amount: 10 }] }, { token: null })
      expect(res.status).toBe(401)
      expect(prisma.$transaction).not.toHaveBeenCalled()
    })

    it('returns 401 for an invalid token', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue(null as never)
      const { res } = await call({ allocations: [{ invoiceId: 'inv-1', amount: 10 }] })
      expect(res.status).toBe(401)
    })

    it('returns 404 for a credit note owned by another user', async () => {
      seed({ note: { userId: 'someone-else' }, invoices: [{}] })
      const { res, body } = await call({ allocations: [{ invoiceId: 'inv-1', amount: 10 }] })
      expect(res.status).toBe(404)
      expect(body).toEqual({ error: 'Credit note not found' })
      expect(prisma.$transaction).not.toHaveBeenCalled()
    })

    it('returns 404 for a missing credit note', async () => {
      const { res } = await call({ allocations: [{ invoiceId: 'inv-1', amount: 10 }] }, { id: 'cn-missing' })
      expect(res.status).toBe(404)
    })

    it('treats another user’s invoice as not found', async () => {
      seed({ invoices: [{ userId: 'someone-else' }] })
      const { res, body } = await call({ allocations: [{ invoiceId: 'inv-1', amount: 10 }] })
      expect(res.status).toBe(404)
      expect(body).toMatchObject({ code: 'INVOICE_NOT_FOUND', details: { invoiceId: 'inv-1' } })
      expect(invoice('inv-1').amount.toFixed(2)).toBe('100.00')
    })
  })

  describe('request validation', () => {
    it('rejects malformed JSON', async () => {
      const { res } = await call('{')
      expect(res.status).toBe(400)
    })

    it.each([{}, { allocations: [] }, { allocations: 'inv-1' }])('rejects body %j', async (payload) => {
      const { res, body } = await call(payload)
      expect(res.status).toBe(400)
      expect(body.code).toBe('VALIDATION_ERROR')
    })

    it('rejects more than 50 allocations', async () => {
      const allocations = Array.from({ length: 51 }, (_, i) => ({ invoiceId: `inv-${i}`, amount: 1 }))
      const { res, body } = await call({ allocations })
      expect(res.status).toBe(400)
      expect(body.error).toMatch(/50/)
    })

    it.each([
      [{ amount: 10 }, /invoiceId/],
      [{ invoiceId: '  ', amount: 10 }, /invoiceId/],
      [{ invoiceId: 'inv-1', amount: 0 }, /amount/],
      [{ invoiceId: 'inv-1', amount: -5 }, /amount/],
      [{ invoiceId: 'inv-1', amount: '10.001' }, /amount/],
      [{ invoiceId: 'inv-1', amount: 'ten' }, /amount/],
    ])('rejects allocation %j', async (allocation, message) => {
      const { res, body } = await call({ allocations: [allocation] })
      expect(res.status).toBe(400)
      expect(body.error).toMatch(message)
    })

    it('rejects duplicate invoice ids deterministically', async () => {
      const { res, body } = await call({
        allocations: [
          { invoiceId: 'inv-1', amount: 10 },
          { invoiceId: 'inv-2', amount: 10 },
          { invoiceId: ' inv-1 ', amount: 5 },
        ],
      })
      expect(res.status).toBe(400)
      expect(body).toEqual({
        error: 'Each invoice may appear only once per request',
        code: 'DUPLICATE_INVOICE',
        details: { invoiceId: 'inv-1' },
      })
      expect(prisma.$transaction).not.toHaveBeenCalled()
    })
  })

  describe('successful application', () => {
    it('applies the entire credit note to one invoice', async () => {
      const { res, body } = await call({ allocations: [{ invoiceId: 'inv-1', amount: 100 }] })

      expect(res.status).toBe(201)
      expect(body.creditNote).toEqual({
        id: 'cn-1',
        creditNumber: 'CN-1',
        currency: 'USD',
        amount: 100,
        appliedAmount: 100,
        remainingBalance: 0,
        status: 'applied',
      })
      expect(body.allocations).toEqual([
        {
          applicationId: 'app-1',
          invoiceId: 'inv-1',
          amount: 100,
          creditRemainingAfter: 0,
          invoiceBalance: 0,
          invoiceStatus: 'paid',
        },
      ])
      expect(note().status).toBe('applied')
      expect(invoice('inv-1').status).toBe('paid')
      expect(invoice('inv-1').paidAt).toBeInstanceOf(Date)
      expect(store.state.applications).toHaveLength(1)
      expect(logAuditEvent).toHaveBeenCalledWith(
        'inv-1',
        'invoice.credit_applied',
        'user-1',
        expect.objectContaining({ creditNoteId: 'cn-1', amount: '100' }),
        expect.anything(),
      )
    })

    it('applies part of the balance and leaves the credit note open', async () => {
      const { res, body } = await call({ allocations: [{ invoiceId: 'inv-1', amount: '30.25' }] })

      expect(res.status).toBe(201)
      expect(body.creditNote).toMatchObject({ appliedAmount: 30.25, remainingBalance: 69.75, status: 'issued' })
      expect(body.allocations[0]).toMatchObject({
        amount: 30.25,
        creditRemainingAfter: 69.75,
        invoiceBalance: 69.75,
        invoiceStatus: 'pending',
      })
      expect(note().appliedAmount.toFixed(2)).toBe('30.25')
      expect(invoice('inv-1').amount.toFixed(2)).toBe('69.75')
    })

    it('splits across multiple invoices, tracking the balance after each allocation', async () => {
      seed({ note: { amount: d('150.00') }, invoices: [{}, { amount: d('40.00'), status: 'overdue' }, {}] })

      const { res, body } = await call({
        allocations: [
          { invoiceId: 'inv-3', amount: 60 },
          { invoiceId: 'inv-2', amount: 40 },
          { invoiceId: 'inv-1', amount: 20 },
        ],
      })

      expect(res.status).toBe(201)
      expect(body.totalApplied).toBe(120)
      expect(body.allocations.map((a: Record<string, unknown>) => [a.invoiceId, a.creditRemainingAfter, a.invoiceBalance, a.invoiceStatus])).toEqual([
        ['inv-3', 90, 40, 'pending'],
        ['inv-2', 50, 0, 'paid'],
        ['inv-1', 30, 80, 'pending'],
      ])
      expect(body.creditNote).toMatchObject({ appliedAmount: 120, remainingBalance: 30, status: 'issued' })
      expect(store.state.applications.map((a) => a.invoiceId).sort()).toEqual(['inv-1', 'inv-2', 'inv-3'])
    })

    it('marks the credit note applied when allocations exactly exhaust it', async () => {
      seed({ note: { appliedAmount: d('40.00') }, invoices: [{}, {}] })

      const { body } = await call({
        allocations: [
          { invoiceId: 'inv-1', amount: '35.50' },
          { invoiceId: 'inv-2', amount: '24.50' },
        ],
      })

      expect(body.creditNote).toMatchObject({ appliedAmount: 100, remainingBalance: 0, status: 'applied' })
      expect(body.allocations[1].creditRemainingAfter).toBe(0)
    })

    it('debits the credit note with a single guarded UPDATE', async () => {
      await call({ allocations: [{ invoiceId: 'inv-1', amount: 10 }] })
      expect(store.rawSql).toHaveLength(1)
      const sql = store.rawSql[0].replace(/\s+/g, ' ')
      expect(sql).toContain('UPDATE "CreditNote"')
      expect(sql).toContain('"status" = \'issued\'')
      expect(sql).toContain('"appliedAmount" + ? <= "amount"')
    })
  })

  describe('credit note balance rules', () => {
    it('rejects requests exceeding the remaining balance without changing anything', async () => {
      seed({ note: { appliedAmount: d('70.00') }, invoices: [{}, {}] })

      const { res, body } = await call({
        allocations: [
          { invoiceId: 'inv-1', amount: 20 },
          { invoiceId: 'inv-2', amount: '10.01' },
        ],
      })

      expect(res.status).toBe(422)
      expect(body).toEqual({
        error: 'Total requested exceeds the credit note remaining balance',
        code: 'INSUFFICIENT_CREDIT_BALANCE',
        details: { requested: 30.01, remainingBalance: 30 },
      })
      expect(note().appliedAmount.toFixed(2)).toBe('70.00')
      expect(prisma.$transaction).not.toHaveBeenCalled()
    })

    it('rejects a credit note already marked applied', async () => {
      seed({ note: { status: 'applied', appliedAmount: d('100.00') }, invoices: [{}] })
      const { res, body } = await call({ allocations: [{ invoiceId: 'inv-1', amount: 1 }] })
      expect(res.status).toBe(409)
      expect(body.code).toBe('CREDIT_NOTE_FULLY_APPLIED')
    })

    it('rejects an issued credit note with no remaining balance', async () => {
      seed({ note: { appliedAmount: d('100.00') }, invoices: [{}] })
      const { res, body } = await call({ allocations: [{ invoiceId: 'inv-1', amount: 1 }] })
      expect(res.status).toBe(409)
      expect(body.code).toBe('CREDIT_NOTE_FULLY_APPLIED')
    })

    it('rejects a voided credit note', async () => {
      seed({ note: { status: 'voided' }, invoices: [{}] })
      const { res, body } = await call({ allocations: [{ invoiceId: 'inv-1', amount: 1 }] })
      expect(res.status).toBe(422)
      expect(body.code).toBe('CREDIT_NOTE_VOIDED')
    })
  })

  describe('invoice eligibility', () => {
    it.each(['paid', 'voided', 'cancelled', 'draft', 'bad_debt'])('rejects a %s invoice', async (status) => {
      seed({ invoices: [{ status }] })
      const { res, body } = await call({ allocations: [{ invoiceId: 'inv-1', amount: 10 }] })
      expect(res.status).toBe(422)
      expect(body).toMatchObject({ code: 'INVOICE_NOT_OPEN', details: { invoiceId: 'inv-1' } })
    })

    it('rejects an invoice in a different currency', async () => {
      seed({ invoices: [{ currency: 'EUR' }] })
      const { res, body } = await call({ allocations: [{ invoiceId: 'inv-1', amount: 10 }] })
      expect(res.status).toBe(422)
      expect(body.code).toBe('CURRENCY_MISMATCH')
    })

    it('rejects an invoice belonging to a different client', async () => {
      seed({ invoices: [{ clientEmail: 'other@example.com' }] })
      const { res, body } = await call({ allocations: [{ invoiceId: 'inv-1', amount: 10 }] })
      expect(res.status).toBe(422)
      expect(body.code).toBe('INVOICE_CLIENT_MISMATCH')
    })

    it('matches the client email case-insensitively', async () => {
      seed({ invoices: [{ clientEmail: 'Client@Example.com' }] })
      const { res } = await call({ allocations: [{ invoiceId: 'inv-1', amount: 10 }] })
      expect(res.status).toBe(201)
    })

    it('rejects an allocation larger than the invoice balance', async () => {
      seed({ invoices: [{ amount: d('25.00') }] })
      const { res, body } = await call({ allocations: [{ invoiceId: 'inv-1', amount: 30 }] })
      expect(res.status).toBe(422)
      expect(body).toMatchObject({
        code: 'ALLOCATION_EXCEEDS_INVOICE_BALANCE',
        details: { invoiceId: 'inv-1', invoiceBalance: 25 },
      })
    })
  })

  describe('atomicity and concurrency', () => {
    it('rolls back every allocation when a later invoice changes mid-request', async () => {
      store.beforeTransaction = () => {
        invoice('inv-2').status = 'paid'
      }

      const { res, body } = await call({
        allocations: [
          { invoiceId: 'inv-1', amount: 30 },
          { invoiceId: 'inv-2', amount: 30 },
        ],
      })

      expect(res.status).toBe(409)
      expect(body).toMatchObject({ code: 'INVOICE_CHANGED', details: { invoiceId: 'inv-2' } })
      expect(note().appliedAmount.toFixed(2)).toBe('0.00')
      expect(note().status).toBe('issued')
      expect(invoice('inv-1').amount.toFixed(2)).toBe('100.00')
      expect(store.state.applications).toHaveLength(0)
    })

    it('lets only one of two concurrent requests consume the same balance', async () => {
      const [a, b] = await Promise.all([
        call({ allocations: [{ invoiceId: 'inv-1', amount: 80 }] }),
        call({ allocations: [{ invoiceId: 'inv-2', amount: 80 }] }),
      ])

      const statuses = [a.res.status, b.res.status].sort()
      expect(statuses).toEqual([201, 409])
      const loser = a.res.status === 409 ? a.body : b.body
      expect(loser.code).toBe('CREDIT_NOTE_BALANCE_CHANGED')

      expect(note().appliedAmount.toFixed(2)).toBe('80.00')
      expect(store.state.applications).toHaveLength(1)
      const debited = [invoice('inv-1').amount, invoice('inv-2').amount].map((x) => x.toFixed(2)).sort()
      expect(debited).toEqual(['100.00', '20.00'])
    })

    it('allows concurrent requests that together fit within the balance', async () => {
      const [a, b] = await Promise.all([
        call({ allocations: [{ invoiceId: 'inv-1', amount: 60 }] }),
        call({ allocations: [{ invoiceId: 'inv-2', amount: 40 }] }),
      ])
      expect([a.res.status, b.res.status]).toEqual([201, 201])
      expect(note().appliedAmount.toFixed(2)).toBe('100.00')
      expect(note().status).toBe('applied')

      // The second request to commit must report the balance left after both,
      // not the stale balance it read before its transaction.
      expect(a.body.allocations[0].creditRemainingAfter).toBe(40)
      expect(b.body.allocations[0].creditRemainingAfter).toBe(0)
      expect(b.body.creditNote).toMatchObject({ remainingBalance: 0, status: 'applied' })
    })
  })

  it('returns a generic 500 without leaking database errors', async () => {
    vi.mocked(prisma.creditNote.findFirst).mockRejectedValueOnce(new Error('relation does not exist'))
    const { res, body } = await call({ allocations: [{ invoiceId: 'inv-1', amount: 10 }] })
    expect(res.status).toBe(500)
    expect(body).toEqual({ error: 'Failed to apply credit note' })
  })
})
