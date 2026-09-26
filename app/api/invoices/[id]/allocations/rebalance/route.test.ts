import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { Decimal } from '@prisma/client/runtime/library'

interface UserRow { id: string; privyId: string }
interface InvoiceRow { id: string; userId: string; status: string; amount: Decimal }
interface LineItemRow { id: string; invoiceId: string; quantity: Decimal; unitPrice: Decimal }
interface CollaboratorRow {
  id: string
  invoiceId: string
  sharePercentage: Decimal
  allocatedAmount: Decimal | null
  rebalancedAt: Date | null
  createdAt: Date
}

interface Store {
  users: Map<string, UserRow>
  invoices: Map<string, InvoiceRow>
  lineItems: LineItemRow[]
  collaborators: CollaboratorRow[]
  auditEvents: unknown[]
}

const store = vi.hoisted((): { state: Store } => ({
  state: { users: new Map(), invoices: new Map(), lineItems: [], collaborators: [], auditEvents: [] },
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { privyId?: string } }) => {
        for (const u of store.state.users.values()) if (u.privyId === where.privyId) return u
        return null
      }),
    },
    invoice: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; userId: string } }) => {
        const inv = store.state.invoices.get(where.id)
        return inv && inv.userId === where.userId ? inv : null
      }),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        $queryRaw: vi.fn(async (_strings: TemplateStringsArray, ...vals: unknown[]) => {
          const invoiceId = vals[0] as string
          const userId = vals[1] as string
          const inv = store.state.invoices.get(invoiceId)
          if (!inv || inv.userId !== userId) return []
          return [{ status: inv.status }]
        }),
        invoiceLineItem: {
          findMany: vi.fn(async ({ where }: { where: { invoiceId: string } }) =>
            store.state.lineItems.filter((li) => li.invoiceId === where.invoiceId)),
        },
        invoiceCollaborator: {
          findMany: vi.fn(async ({ where }: { where: { invoiceId: string } }) =>
            store.state.collaborators
              .filter((c) => c.invoiceId === where.invoiceId)
              .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())),
          update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<CollaboratorRow> }) => {
            const c = store.state.collaborators.find((x) => x.id === where.id)
            if (!c) throw new Error('not found')
            Object.assign(c, data)
            return c
          }),
        },
        invoice: {
          update: vi.fn(async ({ where, data }: { where: { id: string }; data: { amount: Decimal } }) => {
            const inv = store.state.invoices.get(where.id)
            if (!inv) throw new Error('not found')
            inv.amount = data.amount
            return inv
          }),
        },
        auditEvent: {
          create: vi.fn(async (data: unknown) => {
            store.state.auditEvents.push(data)
            return data
          }),
        },
      }
      return fn(tx)
    }),
  },
}))

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(async (invoiceId, eventType, actorId, metadata, tx) => {
    return tx.auditEvent.create({ data: { invoiceId, eventType, actorId, metadata } })
  }),
  extractRequestMetadata: vi.fn(() => ({})),
}))

import { POST } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const d = (v: string) => new Decimal(v)

function seed(overrides: {
  invoice?: Partial<InvoiceRow>
  lineItems?: Partial<LineItemRow>[]
  collaborators?: Partial<CollaboratorRow>[]
} = {}) {
  const user: UserRow = { id: 'user-1', privyId: 'privy-1' }
  store.state.users.set(user.id, user)
  ;(verifyAuthToken as ReturnType<typeof vi.fn>).mockResolvedValue({ userId: user.privyId })
  ;(prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(user)

  const inv: InvoiceRow = { id: 'inv-1', userId: user.id, status: 'pending', amount: d('100.00'), ...overrides.invoice }
  store.state.invoices.set(inv.id, inv)

  store.state.lineItems = (overrides.lineItems ?? [{ quantity: d('1'), unitPrice: d('100.00') }]).map((li, i) => ({
    id: `li-${i + 1}`, invoiceId: inv.id, quantity: d('1'), unitPrice: d('0'), ...li,
  }))

  store.state.collaborators = (overrides.collaborators ?? []).map((c, i) => ({
    id: `collab-${i + 1}`,
    invoiceId: inv.id,
    sharePercentage: d('0'),
    allocatedAmount: null,
    rebalancedAt: null,
    createdAt: new Date(2026, 0, i + 1),
    ...c,
  }))
}

function postReq(invoiceId: string, token: string | null = 'tok') {
  return new NextRequest(`http://localhost/api/invoices/${invoiceId}/allocations/rebalance`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

describe('POST /api/invoices/[id]/allocations/rebalance', () => {
  beforeEach(() => {
    store.state = { users: new Map(), invoices: new Map(), lineItems: [], collaborators: [], auditEvents: [] }
    vi.clearAllMocks()
  })

  it('recomputes proportional allocations against the new total, remainder on the last one', async () => {
    seed({
      invoice: { amount: d('300.00') },
      lineItems: [{ quantity: d('1'), unitPrice: d('100.00') }],
      collaborators: [
        { sharePercentage: d('33.33') },
        { sharePercentage: d('33.33') },
        { sharePercentage: d('33.34') },
      ],
    })

    const res = await POST(postReq('inv-1'), { params: Promise.resolve({ id: 'inv-1' }) })
    expect(res.status).toBe(200)
    const json = await res.json()

    expect(json.invoice.amount).toBe('100.00')
    const amounts = json.allocations.map((a: { allocatedAmount: string }) => Number(a.allocatedAmount))
    const sum = amounts.reduce((s: number, a: number) => s + a, 0)
    expect(sum).toBeCloseTo(100, 2)
    expect(json.allocations).toHaveLength(3)
  })

  it('excludes removed line items from the new total (they were already deleted)', async () => {
    seed({
      invoice: { amount: d('300.00') },
      lineItems: [{ quantity: d('1'), unitPrice: d('80.00') }, { quantity: d('1'), unitPrice: d('20.00') }],
      collaborators: [{ sharePercentage: d('100') }],
    })

    const res = await POST(postReq('inv-1'), { params: Promise.resolve({ id: 'inv-1' }) })
    const json = await res.json()
    expect(json.invoice.amount).toBe('100.00')
    expect(json.allocations[0].allocatedAmount).toBe('100.00')
  })

  it('rejects rebalancing an already fully paid invoice', async () => {
    seed({ invoice: { status: 'paid' } })
    const res = await POST(postReq('inv-1'), { params: Promise.resolve({ id: 'inv-1' }) })
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.code).toBe('INVOICE_ALREADY_PAID')
  })

  it('returns 404 when the invoice does not exist or is not owned by the caller', async () => {
    seed()
    const res = await POST(postReq('ghost'), { params: Promise.resolve({ id: 'ghost' }) })
    expect(res.status).toBe(404)
  })

  it('returns 401 when unauthenticated', async () => {
    seed()
    const res = await POST(postReq('inv-1', null), { params: Promise.resolve({ id: 'inv-1' }) })
    expect(res.status).toBe(401)
  })

  it('handles an invoice with no collaborators by only updating the total', async () => {
    seed({ invoice: { amount: d('300.00') }, lineItems: [{ quantity: d('1'), unitPrice: d('50.00') }], collaborators: [] })
    const res = await POST(postReq('inv-1'), { params: Promise.resolve({ id: 'inv-1' }) })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.invoice.amount).toBe('50.00')
    expect(json.allocations).toHaveLength(0)
  })

  it('handles an invoice with zero remaining line items (all disputed away)', async () => {
    seed({ invoice: { amount: d('300.00') }, lineItems: [], collaborators: [{ sharePercentage: d('100') }] })
    const res = await POST(postReq('inv-1'), { params: Promise.resolve({ id: 'inv-1' }) })
    const json = await res.json()
    expect(json.invoice.amount).toBe('0.00')
    expect(json.allocations[0].allocatedAmount).toBe('0.00')
  })

  it('preserves each collaborator relative proportion when the total shrinks', async () => {
    seed({
      invoice: { amount: d('300.00') },
      lineItems: [{ quantity: d('1'), unitPrice: d('60.00') }],
      collaborators: [{ sharePercentage: d('75') }, { sharePercentage: d('25') }],
    })
    const res = await POST(postReq('inv-1'), { params: Promise.resolve({ id: 'inv-1' }) })
    const json = await res.json()
    expect(json.allocations[0].allocatedAmount).toBe('45.00')
    expect(json.allocations[1].allocatedAmount).toBe('15.00')
  })

  it('logs an audit event for the rebalance', async () => {
    seed({
      invoice: { amount: d('300.00') },
      lineItems: [{ quantity: d('1'), unitPrice: d('100.00') }],
      collaborators: [{ sharePercentage: d('100') }],
    })
    await POST(postReq('inv-1'), { params: Promise.resolve({ id: 'inv-1' }) })
    expect(store.state.auditEvents).toHaveLength(1)
  })
})
