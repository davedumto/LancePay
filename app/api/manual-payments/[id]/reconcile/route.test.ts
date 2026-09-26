import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { Decimal } from '@prisma/client/runtime/library'

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

interface UserRow { id: string; privyId: string; timezone: string | null }
interface ManualPaymentRow {
  id: string; invoiceUserId: string; invoiceId: string
  amountPaid: Decimal; currency: string; status: string
  reconciledAt: Date | null; reconciledBy: string | null; bankStatementLineId: string | null
  createdAt: Date
}
interface BankLineRow {
  id: string; userId: string; amount: Decimal; currency: string
  transactionDate: Date; manualPaymentId: string | null
}

interface Store {
  users: Map<string, UserRow>
  payments: Map<string, ManualPaymentRow>
  bankLines: Map<string, BankLineRow>
  auditEvents: unknown[]
}

const store = vi.hoisted((): { state: Store } => ({
  state: { users: new Map(), payments: new Map(), bankLines: new Map(), auditEvents: [] },
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { privyId?: string } }) => {
        for (const u of store.state.users.values()) {
          if (u.privyId === where.privyId) return u
        }
        return null
      }),
    },
    manualPayment: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; invoice: { userId: string } } }) => {
        const p = store.state.payments.get(where.id)
        if (!p || p.invoiceUserId !== where.invoice.userId) return null
        return {
          id: p.id, invoiceId: p.invoiceId,
          amountPaid: p.amountPaid, currency: p.currency,
          status: p.status, reconciledAt: p.reconciledAt,
          bankStatementLineId: p.bankStatementLineId, createdAt: p.createdAt,
        }
      }),
      updateMany: vi.fn(async ({ where, data }: {
        where: {
          id: string; reconciledAt: null; bankStatementLineId: null
          status: { in: string[] }
        }
        data: { status: string; reconciledAt: Date; reconciledBy: string; bankStatementLineId: string }
      }) => {
        const p = store.state.payments.get(where.id)
        if (!p || p.reconciledAt !== null || p.bankStatementLineId !== null) return { count: 0 }
        if (!where.status.in.includes(p.status)) return { count: 0 }
        p.status = data.status
        p.reconciledAt = data.reconciledAt
        p.reconciledBy = data.reconciledBy
        p.bankStatementLineId = data.bankStatementLineId
        const line = store.state.bankLines.get(data.bankStatementLineId)
        if (line) line.manualPaymentId = p.id
        return { count: 1 }
      }),
    },
    bankStatementLine: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; userId: string } }) => {
        const l = store.state.bankLines.get(where.id)
        if (!l || l.userId !== where.userId) return null
        return {
          id: l.id, amount: l.amount, currency: l.currency,
          transactionDate: l.transactionDate,
          manualPayment: l.manualPaymentId ? { id: l.manualPaymentId } : null,
        }
      }),
    },
    auditEvent: {
      create: vi.fn(async (data: unknown) => {
        store.state.auditEvents.push(data)
        return data
      }),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      // Pass a tx that shares store state
      const tx = {
        manualPayment: {
          updateMany: (prisma as unknown as { manualPayment: { updateMany: typeof vi.fn } }).manualPayment.updateMany,
        },
        auditEvent: {
          create: (prisma as unknown as { auditEvent: { create: typeof vi.fn } }).auditEvent.create,
        },
      }
      return fn(tx)
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const d = (v: string) => new Decimal(v)

function seed(overrides: {
  user?: Partial<UserRow>
  payment?: Partial<ManualPaymentRow>
  bankLine?: Partial<BankLineRow>
} = {}) {
  const user: UserRow = { id: 'user-1', privyId: 'privy-1', timezone: 'UTC', ...overrides.user }
  store.state.users.set(user.id, user)
  ;(verifyAuthToken as ReturnType<typeof vi.fn>).mockResolvedValue({ userId: user.privyId })
  ;(prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(user)

  const payDate = new Date('2026-01-15T12:00:00Z')
  const payment: ManualPaymentRow = {
    id: 'pay-1', invoiceUserId: user.id, invoiceId: 'inv-1',
    amountPaid: d('1000.00'), currency: 'NGN', status: 'pending',
    reconciledAt: null, reconciledBy: null, bankStatementLineId: null,
    createdAt: payDate, ...overrides.payment,
  }
  store.state.payments.set(payment.id, payment)

  const lineDate = new Date('2026-01-15T00:00:00Z')
  const line: BankLineRow = {
    id: 'line-1', userId: user.id, amount: d('1000.00'), currency: 'NGN',
    transactionDate: lineDate, manualPaymentId: null, ...overrides.bankLine,
  }
  store.state.bankLines.set(line.id, line)
}

function postReq(paymentId: string, body: unknown, token: string | null = 'tok') {
  return new NextRequest(`http://localhost/api/manual-payments/${paymentId}/reconcile`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('POST /api/manual-payments/[id]/reconcile', () => {
  beforeEach(() => {
    store.state = { users: new Map(), payments: new Map(), bankLines: new Map(), auditEvents: [] }
    vi.clearAllMocks()
  })

  it('reconciles a payment and records the bank line relationship', async () => {
    seed()
    const res = await POST(postReq('pay-1', { bankStatementLineId: 'line-1' }), {
      params: Promise.resolve({ id: 'pay-1' }),
    })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.manualPayment.status).toBe('reconciled')
    expect(json.manualPayment.reconciledBy).toBe('user-1')
    expect(json.bankStatementLine.id).toBe('line-1')
    // Payment row updated in store
    expect(store.state.payments.get('pay-1')?.bankStatementLineId).toBe('line-1')
  })

  it('accepts amount within tolerance (exactly at boundary)', async () => {
    seed({ payment: { amountPaid: d('1001.00') } }) // diff = 1.00 = default tolerance
    const res = await POST(postReq('pay-1', { bankStatementLineId: 'line-1' }), {
      params: Promise.resolve({ id: 'pay-1' }),
    })
    expect(res.status).toBe(200)
  })

  it('rejects amount outside tolerance', async () => {
    seed({ payment: { amountPaid: d('1001.01') } }) // diff = 1.01 > 1.00
    const res = await POST(postReq('pay-1', { bankStatementLineId: 'line-1' }), {
      params: Promise.resolve({ id: 'pay-1' }),
    })
    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.code).toBe('AMOUNT_OUTSIDE_TOLERANCE')
  })

  it('accepts date within tolerance (3 calendar days)', async () => {
    // payCreatedAt = 2026-01-15, lineDate = 2026-01-18 → 3 days = within default
    seed({ bankLine: { transactionDate: new Date('2026-01-18T00:00:00Z') } })
    const res = await POST(postReq('pay-1', { bankStatementLineId: 'line-1' }), {
      params: Promise.resolve({ id: 'pay-1' }),
    })
    expect(res.status).toBe(200)
  })

  it('rejects date outside tolerance (4 calendar days)', async () => {
    seed({ bankLine: { transactionDate: new Date('2026-01-19T00:00:00Z') } })
    const res = await POST(postReq('pay-1', { bankStatementLineId: 'line-1' }), {
      params: Promise.resolve({ id: 'pay-1' }),
    })
    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.code).toBe('DATE_OUTSIDE_TOLERANCE')
  })

  it('rejects currency mismatch', async () => {
    seed({ bankLine: { currency: 'USD' } })
    const res = await POST(postReq('pay-1', { bankStatementLineId: 'line-1' }), {
      params: Promise.resolve({ id: 'pay-1' }),
    })
    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.code).toBe('CURRENCY_MISMATCH')
  })

  it('rejects already-reconciled payment', async () => {
    seed({ payment: { reconciledAt: new Date(), bankStatementLineId: 'other-line' } })
    const res = await POST(postReq('pay-1', { bankStatementLineId: 'line-1' }), {
      params: Promise.resolve({ id: 'pay-1' }),
    })
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.code).toBe('ALREADY_RECONCILED')
  })

  it('returns 409 when bank line is already matched to another payment', async () => {
    seed({ bankLine: { manualPaymentId: 'pay-other' } })
    const res = await POST(postReq('pay-1', { bankStatementLineId: 'line-1' }), {
      params: Promise.resolve({ id: 'pay-1' }),
    })
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.code).toBe('BANK_LINE_ALREADY_MATCHED')
  })

  it('returns 404 when payment not found', async () => {
    seed()
    const res = await POST(postReq('pay-ghost', { bankStatementLineId: 'line-1' }), {
      params: Promise.resolve({ id: 'pay-ghost' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 404 when bank line not found or not owned by user', async () => {
    seed()
    const res = await POST(postReq('pay-1', { bankStatementLineId: 'line-ghost' }), {
      params: Promise.resolve({ id: 'pay-1' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 400 when bankStatementLineId is missing', async () => {
    seed()
    const res = await POST(postReq('pay-1', {}), {
      params: Promise.resolve({ id: 'pay-1' }),
    })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.code).toBe('INVALID_BODY')
  })

  it('returns 401 when no token', async () => {
    seed()
    const res = await POST(postReq('pay-1', { bankStatementLineId: 'line-1' }, null), {
      params: Promise.resolve({ id: 'pay-1' }),
    })
    expect(res.status).toBe(401)
  })

  it('returns 422 for non-reconcilable status', async () => {
    seed({ payment: { status: 'cancelled' } })
    const res = await POST(postReq('pay-1', { bankStatementLineId: 'line-1' }), {
      params: Promise.resolve({ id: 'pay-1' }),
    })
    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.code).toBe('PAYMENT_NOT_RECONCILABLE')
  })

  it('concurrent requests: second reconcile returns 409', async () => {
    seed()
    const params = { params: Promise.resolve({ id: 'pay-1' }) }
    // First request succeeds and marks payment reconciled
    const [r1, r2] = await Promise.all([
      POST(postReq('pay-1', { bankStatementLineId: 'line-1' }), params),
      POST(postReq('pay-1', { bankStatementLineId: 'line-1' }), params),
    ])
    const statuses = [r1.status, r2.status].sort()
    expect(statuses).toEqual([200, 409])
  })
})
