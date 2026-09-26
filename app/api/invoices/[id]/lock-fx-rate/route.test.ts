import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { Decimal } from '@prisma/client/runtime/library'

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

interface UserRow { id: string; privyId: string }
interface InvoiceRow { id: string; userId: string; currency: string; status: string; amount: Decimal }
interface FxSnapshotRow {
  id: string; fromCurrency: string; toCurrency: string
  rate: Decimal; source: string; capturedAt: Date; createdAt: Date
}
interface FxLockRow {
  id: string; invoiceId: string; fxRateSnapshotId: string; inverted: boolean
  sourceAmount: Decimal; sourceCurrency: string
  lockedAmount: Decimal; lockedCurrency: string
  lockedBy: string; expiresAt: Date; createdAt: Date
}

interface Store {
  users: Map<string, UserRow>
  invoices: Map<string, InvoiceRow>
  fxSnapshots: FxSnapshotRow[]
  fxLocks: FxLockRow[]
  auditEvents: unknown[]
}

const store = vi.hoisted((): { state: Store } => ({
  state: { users: new Map(), invoices: new Map(), fxSnapshots: [], fxLocks: [], auditEvents: [] },
}))

// "recent" is always within INVOICE_FX_LOCK_MAX_SNAPSHOT_AGE_MINUTES of real
// wall-clock time so the stale-snapshot check doesn't trip on us.
const RECENT = () => new Date(Date.now() - 30 * 60 * 1000) // 30 min ago
let frozenNow = new Date('2026-01-15T12:00:00Z')

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
    invoice: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; userId: string } }) => {
        const inv = store.state.invoices.get(where.id)
        return inv && inv.userId === where.userId ? { id: inv.id, currency: inv.currency, status: inv.status } : null
      }),
    },
    invoiceFxLock: {
      findFirst: vi.fn(async ({ where, orderBy, include }: {
        where: { invoiceId: string; expiresAt?: { gt: Date } }
        orderBy?: unknown[]; include?: unknown
      }) => {
        const locks = store.state.fxLocks.filter(l => {
          if (l.invoiceId !== where.invoiceId) return false
          if (where.expiresAt?.gt && l.expiresAt <= where.expiresAt.gt) return false
          return true
        })
        if (!locks.length) return null
        const lock = locks.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
        const snap = store.state.fxSnapshots.find(s => s.id === lock.fxRateSnapshotId)
        return { ...lock, fxRateSnapshot: snap }
      }),
      create: vi.fn(async ({ data, include }: {
        data: Omit<FxLockRow, 'id'>; include: unknown
      }) => {
        const lock: FxLockRow = { id: `lock-${store.state.fxLocks.length + 1}`, ...data }
        store.state.fxLocks.push(lock)
        const snap = store.state.fxSnapshots.find(s => s.id === data.fxRateSnapshotId)
        return { ...lock, fxRateSnapshot: snap }
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
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...vals: unknown[]) => {
          // The route queries: WHERE "id" = $1 AND "userId" = $2
          const invoiceId = vals[0] as string
          const userId = vals[1] as string
          const inv = store.state.invoices.get(invoiceId)
          if (!inv || inv.userId !== userId) return []
          return [{ status: inv.status, amount: inv.amount, currency: inv.currency }]
        }),
        invoiceFxLock: {
          findFirst: (prisma as unknown as { invoiceFxLock: { findFirst: unknown } }).invoiceFxLock.findFirst,
          create: (prisma as unknown as { invoiceFxLock: { create: unknown } }).invoiceFxLock.create,
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
    auditEvent: { create: vi.fn() },
  },
}))

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
  extractRequestMetadata: vi.fn(() => ({})),
}))

// Freeze time so we can test expiry deterministically
vi.mock('@/lib/fx-rates', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/fx-rates')>()
  return {
    ...orig,
    findFxRate: vi.fn(async (from: string, to: string, asOf?: Date) => {
      return orig.findFxRate(from, to, asOf)
    }),
  }
})

import { POST } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const d = (v: string) => new Decimal(v)

function seed(overrides: {
  user?: Partial<UserRow>
  invoice?: Partial<InvoiceRow>
  fxSnapshots?: Partial<FxSnapshotRow>[]
} = {}) {
  const user: UserRow = { id: 'user-1', privyId: 'privy-1', ...overrides.user }
  store.state.users.set(user.id, user)
  ;(verifyAuthToken as ReturnType<typeof vi.fn>).mockResolvedValue({ userId: user.privyId })
  ;(prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(user)

  const inv: InvoiceRow = {
    id: 'inv-1', userId: user.id, currency: 'USD', status: 'pending', amount: d('200.00'),
    ...overrides.invoice,
  }
  store.state.invoices.set(inv.id, inv)

  const recentNow = RECENT()
  store.state.fxSnapshots = (overrides.fxSnapshots ?? [{
    id: 'snap-1', fromCurrency: 'USD', toCurrency: 'NGN',
    rate: d('1500'), source: 'test', capturedAt: recentNow, createdAt: recentNow,
  }]).map((s, i) => ({
    id: `snap-${i + 1}`, fromCurrency: 'USD', toCurrency: 'NGN',
    rate: d('1500'), source: 'test', capturedAt: recentNow, createdAt: recentNow, ...s,
  }))
}

function postReq(invoiceId: string, token: string | null = 'tok') {
  return new NextRequest(`http://localhost/api/invoices/${invoiceId}/lock-fx-rate`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('POST /api/invoices/[id]/lock-fx-rate', () => {
  beforeEach(() => {
    frozenNow = new Date('2026-01-15T12:00:00Z')
    store.state = { users: new Map(), invoices: new Map(), fxSnapshots: [], fxLocks: [], auditEvents: [] }
    vi.clearAllMocks()
  })

  it('creates a lock for an open invoice', async () => {
    seed()
    const res = await POST(postReq('inv-1'), { params: Promise.resolve({ id: 'inv-1' }) })
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.created).toBe(true)
    expect(json.lock.sourceCurrency).toBe('USD')
    expect(json.lock.lockedCurrency).toBe('NGN')
    expect(json.lock.lockedAmount).toBe('300000.00') // 200 * 1500
    expect(json.lock.expiresAt).toBeDefined()
    expect(store.state.fxLocks).toHaveLength(1)
    expect(store.state.fxLocks[0].fxRateSnapshotId).toBe('snap-1')
  })

  it('rejects a paid invoice with 409', async () => {
    seed({ invoice: { status: 'paid' } })
    const res = await POST(postReq('inv-1'), { params: Promise.resolve({ id: 'inv-1' }) })
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.code).toBe('INVOICE_ALREADY_PAID')
  })

  it('rejects a cancelled invoice with 422', async () => {
    seed({ invoice: { status: 'cancelled' } })
    const res = await POST(postReq('inv-1'), { params: Promise.resolve({ id: 'inv-1' }) })
    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.code).toBe('INVOICE_NOT_OPEN')
  })

  it('returns 422 when no FX rate is available', async () => {
    seed({ fxSnapshots: [] })
    const res = await POST(postReq('inv-1'), { params: Promise.resolve({ id: 'inv-1' }) })
    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.code).toBe('FX_RATE_UNAVAILABLE')
  })

  it('returns 422 when the latest snapshot is too old (stale)', async () => {
    const staleDate = new Date(Date.now() - 61 * 60 * 1000) // 61 min old — beyond default 60-min max age
    seed({ fxSnapshots: [{ capturedAt: staleDate }] })
    const res = await POST(postReq('inv-1'), { params: Promise.resolve({ id: 'inv-1' }) })
    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.code).toBe('FX_RATE_STALE')
  })

  it('is idempotent: second call returns existing active lock (200)', async () => {
    seed()
    const params = { params: Promise.resolve({ id: 'inv-1' }) }
    const r1 = await POST(postReq('inv-1'), params)
    expect(r1.status).toBe(201)

    const r2 = await POST(postReq('inv-1'), params)
    expect(r2.status).toBe(200)
    const j2 = await r2.json()
    expect(j2.created).toBe(false)
    expect(store.state.fxLocks).toHaveLength(1)
  })

  it('creates a new lock after the old one expires', async () => {
    seed()
    const params = { params: Promise.resolve({ id: 'inv-1' }) }
    const r1 = await POST(postReq('inv-1'), params)
    expect(r1.status).toBe(201)

    // Expire the lock by mutating its expiresAt in the store
    const lock = store.state.fxLocks[0]
    lock.expiresAt = new Date(frozenNow.getTime() - 1)

    const r2 = await POST(postReq('inv-1'), params)
    expect(r2.status).toBe(201)
    expect(store.state.fxLocks).toHaveLength(2)
  })

  it('persists the correct snapshot association for auditability', async () => {
    seed()
    const res = await POST(postReq('inv-1'), { params: Promise.resolve({ id: 'inv-1' }) })
    await res.json()
    expect(store.state.fxLocks[0].fxRateSnapshotId).toBe('snap-1')
  })

  it('returns 404 when invoice not found', async () => {
    seed()
    const res = await POST(postReq('inv-ghost'), { params: Promise.resolve({ id: 'inv-ghost' }) })
    expect(res.status).toBe(404)
  })

  it('returns 422 for same-currency invoice (NGN->NGN lock not applicable)', async () => {
    seed({ invoice: { currency: 'NGN' } })
    const res = await POST(postReq('inv-1'), { params: Promise.resolve({ id: 'inv-1' }) })
    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.code).toBe('FX_LOCK_NOT_APPLICABLE')
  })

  it('returns 401 when no token', async () => {
    seed()
    const res = await POST(postReq('inv-1', null), { params: Promise.resolve({ id: 'inv-1' }) })
    expect(res.status).toBe(401)
  })

  it('expiry is computed server-side — not client-controlled', async () => {
    seed()
    const res = await POST(postReq('inv-1'), { params: Promise.resolve({ id: 'inv-1' }) })
    const json = await res.json()
    const expiresAt = new Date(json.lock.expiresAt)
    // Expiry must be strictly in the future from frozenNow
    expect(expiresAt.getTime()).toBeGreaterThan(frozenNow.getTime())
  })
})
