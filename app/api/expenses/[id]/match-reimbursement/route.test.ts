import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { Decimal } from '@prisma/client/runtime/library'

interface UserRow { id: string; privyId: string; homeCurrency: string }
interface ExpenseRow {
  id: string; userId: string; category: string; description: string
  amount: Decimal; currency: string; expenseDate: Date
  reimbursementMatch: { id: string } | null
}
interface InvoiceRow { id: string; userId: string; currency: string; status: string; amount: Decimal }
interface FxSnapshotRow {
  id: string; fromCurrency: string; toCurrency: string
  rate: Decimal; source: string; capturedAt: Date; createdAt: Date
}
interface InvoiceLineItemRow {
  id: string; invoiceId: string; description: string; quantity: number; unitPrice: Decimal; position: number
}
interface ExpenseReimbursementMatchRow {
  id: string; expenseId: string; invoiceId: string
}

interface Store {
  users: Map<string, UserRow>
  expenses: Map<string, ExpenseRow>
  invoices: Map<string, InvoiceRow>
  fxSnapshots: FxSnapshotRow[]
  invoiceLineItems: InvoiceLineItemRow[]
  matches: ExpenseReimbursementMatchRow[]
}

const store = vi.hoisted((): { state: Store } => ({
  state: {
    users: new Map(),
    expenses: new Map(),
    invoices: new Map(),
    fxSnapshots: [],
    invoiceLineItems: [],
    matches: [],
  },
}))

vi.mock('@/lib/db', () => {
  return {
    prisma: {
      user: {
        findUnique: vi.fn(async ({ where }: { where: { privyId?: string } }) => {
          for (const u of store.state.users.values()) {
            if (u.privyId === where.privyId) return u
          }
          return null
        }),
      },
      expense: {
        findFirst: vi.fn(async ({ where }: { where: { id: string; userId: string } }) => {
          const e = store.state.expenses.get(where.id)
          return e && e.userId === where.userId ? e : null
        }),
      },
      invoice: {
        findFirst: vi.fn(async ({ where }: { where: { id: string; userId: string } }) => {
          const inv = store.state.invoices.get(where.id)
          return inv && inv.userId === where.userId ? inv : null
        }),
      },
      invoiceLineItem: {
        findFirst: vi.fn(async ({ where }: { where: { invoiceId: string } }) => {
          const items = store.state.invoiceLineItems.filter(i => i.invoiceId === where.invoiceId)
          if (!items.length) return null
          return items.sort((a, b) => b.position - a.position)[0]
        }),
      },
      fxRateSnapshot: {
        findFirst: vi.fn(async ({ where, orderBy }: {
          where: { fromCurrency: string; toCurrency: string; capturedAt?: { lte: Date } }
          orderBy: { capturedAt: 'desc' }
        }) => {
          const { fromCurrency, toCurrency, capturedAt } = where
          const candidates = store.state.fxSnapshots.filter(s =>
            s.fromCurrency === fromCurrency &&
            s.toCurrency === toCurrency &&
            (!capturedAt?.lte || s.capturedAt <= capturedAt.lte),
          )
          if (!candidates.length) return null
          return candidates.sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime())[0]
        }),
      },
      $transaction: vi.fn(async (callback: any) => {
        // mock tx
        const tx = {
          expenseReimbursementMatch: {
            create: vi.fn(async ({ data }: any) => {
              const match = { id: 'match-new', ...data }
              store.state.matches.push(match)
              return match
            })
          },
          invoiceLineItem: {
            create: vi.fn(async ({ data }: any) => {
              const item = { id: 'li-new', ...data }
              store.state.invoiceLineItems.push(item)
              return item
            })
          },
          invoice: {
            update: vi.fn(async ({ where, data }: any) => {
              const inv = store.state.invoices.get(where.id)
              if (inv && data.amount?.increment) {
                inv.amount = inv.amount.plus(data.amount.increment)
              }
              return inv
            })
          }
        }
        return callback(tx)
      }),
    },
  }
})

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { POST } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const d = (v: string) => new Decimal(v)

function seed(overrides: {
  user?: Partial<UserRow>
  expenses?: Partial<ExpenseRow>[]
  invoices?: Partial<InvoiceRow>[]
  fxSnapshots?: Partial<FxSnapshotRow>[]
} = {}) {
  const user: UserRow = {
    id: 'user-1', privyId: 'privy-1', homeCurrency: 'NGN',
    ...overrides.user,
  }
  store.state.users.set(user.id, user)
  ;(verifyAuthToken as ReturnType<typeof vi.fn>).mockResolvedValue({ userId: user.privyId })

  const now = new Date('2026-01-15T12:00:00Z')
  store.state.expenses = new Map(
    (overrides.expenses ?? []).map((e, i) => {
      const row: ExpenseRow = {
        id: `exp-${i + 1}`, userId: user.id, category: 'travel',
        description: 'taxi', amount: d('100.00'), currency: 'USD',
        expenseDate: now, reimbursementMatch: null, ...e,
      }
      return [row.id, row]
    }),
  )

  store.state.invoices = new Map(
    (overrides.invoices ?? []).map((inv, i) => {
      const row: InvoiceRow = {
        id: `inv-${i + 1}`, userId: user.id, currency: 'NGN',
        status: 'pending', amount: d('0.00'), ...inv,
      }
      return [row.id, row]
    }),
  )

  store.state.fxSnapshots = (overrides.fxSnapshots ?? []).map((s, i) => ({
    id: `snap-${i + 1}`, fromCurrency: 'USD', toCurrency: 'NGN',
    rate: d('1500'), source: 'test', capturedAt: now, createdAt: now, ...s,
  }))
}

function req(expenseId: string, body?: any, token: string | null = 'tok') {
  return new NextRequest(`http://localhost/api/expenses/${expenseId}/match-reimbursement`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}`, 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
}

describe('POST /api/expenses/[id]/match-reimbursement', () => {
  beforeEach(() => {
    store.state = {
      users: new Map(), expenses: new Map(), invoices: new Map(),
      fxSnapshots: [], invoiceLineItems: [], matches: [],
    }
    vi.clearAllMocks()
  })

  it('matches expense and adds invoice line item using historical FX rate', async () => {
    const expenseDate = new Date('2026-01-10T10:00:00Z')
    seed({
      expenses: [{ id: 'exp-1', amount: d('100'), currency: 'USD', expenseDate, category: 'Food', description: 'Lunch' }],
      invoices: [{ id: 'inv-1', currency: 'NGN', amount: d('1000') }],
      fxSnapshots: [
        { rate: d('1400'), capturedAt: expenseDate },
        { rate: d('1500'), capturedAt: new Date() }
      ]
    })

    const request = req('exp-1', { invoiceId: 'inv-1' })
    const res = await POST(request, { params: Promise.resolve({ id: 'exp-1' }) })
    expect(res.status).toBe(201)
    
    const json = await res.json()
    // Historical 100 * 1400 = 140000
    // Current 100 * 1500 = 150000
    
    expect(json.conversion.atIncurred).toBe('140000.00')
    expect(json.conversion.atCurrent).toBe('150000.00')
    expect(json.conversion.delta).toBe('10000.00')

    expect(json.lineItem.unitPrice).toBe(140000)
    expect(json.lineItem.description).toContain('Reimbursement: Food - Lunch')
    
    expect(store.state.matches).toHaveLength(1)
    expect(store.state.matches[0].expenseId).toBe('exp-1')
    expect(store.state.matches[0].invoiceId).toBe('inv-1')
    
    expect(store.state.invoiceLineItems).toHaveLength(1)
    expect(store.state.invoiceLineItems[0].invoiceId).toBe('inv-1')
    
    expect(store.state.invoices.get('inv-1')?.amount.toString()).toBe('141000')
  })

  it('rejects matching an expense that is already matched', async () => {
    seed({
      expenses: [{ id: 'exp-1', reimbursementMatch: { id: 'match-old' } }],
      invoices: [{ id: 'inv-1' }],
      fxSnapshots: [{ rate: d('1500') }]
    })

    const res = await POST(req('exp-1', { invoiceId: 'inv-1' }), { params: Promise.resolve({ id: 'exp-1' }) })
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.error).toMatch(/already matched/)
  })

  it('rejects when invoice is paid', async () => {
    seed({
      expenses: [{ id: 'exp-1' }],
      invoices: [{ id: 'inv-1', status: 'paid' }],
      fxSnapshots: [{ rate: d('1500') }]
    })

    const res = await POST(req('exp-1', { invoiceId: 'inv-1' }), { params: Promise.resolve({ id: 'exp-1' }) })
    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.error).toMatch(/paid invoice/)
  })

  it('rejects when missing invoiceId', async () => {
    seed({ expenses: [{ id: 'exp-1' }] })
    const res = await POST(req('exp-1', {}), { params: Promise.resolve({ id: 'exp-1' }) })
    expect(res.status).toBe(400)
  })

  it('returns 404 for unknown expense', async () => {
    seed({ invoices: [{ id: 'inv-1' }] })
    const res = await POST(req('exp-unknown', { invoiceId: 'inv-1' }), { params: Promise.resolve({ id: 'exp-unknown' }) })
    expect(res.status).toBe(404)
  })

  it('returns 404 for unknown invoice', async () => {
    seed({ expenses: [{ id: 'exp-1' }] })
    const res = await POST(req('exp-1', { invoiceId: 'inv-unknown' }), { params: Promise.resolve({ id: 'exp-1' }) })
    expect(res.status).toBe(404)
  })
})
