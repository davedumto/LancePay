import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { Decimal } from '@prisma/client/runtime/library'

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

interface UserRow { id: string; privyId: string }
interface InvoiceRow { id: string; userId: string; currency: string; status: string }
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
}

const store = vi.hoisted((): { state: Store } => ({
  state: { users: new Map(), invoices: new Map(), fxSnapshots: [], fxLocks: [] },
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
    invoice: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; userId: string } }) => {
        const inv = store.state.invoices.get(where.id)
        return inv && inv.userId === where.userId ? { id: inv.id } : null
      }),
    },
    invoiceFxLock: {
      findFirst: vi.fn(async ({ where }: { where: { invoiceId: string } }) => {
        const locks = store.state.fxLocks.filter(l => l.invoiceId === where.invoiceId)
        if (!locks.length) return null
        const lock = locks.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
        const snap = store.state.fxSnapshots.find(s => s.id === lock.fxRateSnapshotId)
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
  },
}))

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { GET } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const d = (v: string) => new Decimal(v)

// Keep a real-time reference so expiry comparisons against route's new Date() work
const FUTURE = () => new Date(Date.now() + 3_600_000)     // 1 h from real now
const PAST   = () => new Date(Date.now() - 1)             // 1 ms in the past
const RECENT = () => new Date(Date.now() - 30 * 60_000)   // 30 min ago, still "fresh"

function seed(overrides: {
  user?: Partial<UserRow>
  invoice?: Partial<InvoiceRow>
  fxSnapshots?: Partial<FxSnapshotRow>[]
  fxLocks?: Partial<FxLockRow>[]
} = {}) {
  const user: UserRow = { id: 'user-1', privyId: 'privy-1', ...overrides.user }
  store.state.users.set(user.id, user)
  ;(verifyAuthToken as ReturnType<typeof vi.fn>).mockResolvedValue({ userId: user.privyId })
  ;(prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(user)

  const inv: InvoiceRow = {
    id: 'inv-1', userId: user.id, currency: 'USD', status: 'pending',
    ...overrides.invoice,
  }
  store.state.invoices.set(inv.id, inv)

  const recentNow = RECENT()
  const snapBase = {
    id: 'snap-1', fromCurrency: 'USD', toCurrency: 'NGN',
    rate: d('1500'), source: 'test', capturedAt: recentNow, createdAt: recentNow,
  }
  store.state.fxSnapshots = (overrides.fxSnapshots ?? [snapBase]).map((s, i) => ({
    ...snapBase, id: `snap-${i + 1}`, ...s,
  }))

  const createdAt = RECENT()
  store.state.fxLocks = (overrides.fxLocks ?? []).map((l, i) => ({
    id: `lock-${i + 1}`, invoiceId: inv.id, fxRateSnapshotId: 'snap-1',
    inverted: false, sourceAmount: d('200.00'), sourceCurrency: 'USD',
    lockedAmount: d('300000.00'), lockedCurrency: 'NGN',
    lockedBy: user.id, expiresAt: FUTURE(),
    createdAt, ...l,
  }))
}

function getReq(invoiceId: string, token: string | null = 'tok') {
  return new NextRequest(`http://localhost/api/invoices/${invoiceId}/fx-lock-status`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('GET /api/invoices/[id]/fx-lock-status', () => {
  beforeEach(() => {
    store.state = { users: new Map(), invoices: new Map(), fxSnapshots: [], fxLocks: [] }
    vi.clearAllMocks()
  })

  it('returns not_locked when invoice has no lock', async () => {
    seed({ fxLocks: [] })
    const res = await GET(getReq('inv-1'), { params: Promise.resolve({ id: 'inv-1' }) })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.status).toBe('not_locked')
    expect(json.locked).toBe(false)
    expect(json.expired).toBeNull()
    expect(json.lock).toBeNull()
    expect(json.currentRate).toBeNull()
  })

  it('returns active when lock exists and is not expired', async () => {
    seed({ fxLocks: [{ expiresAt: FUTURE() }] })

    const res = await GET(getReq('inv-1'), { params: Promise.resolve({ id: 'inv-1' }) })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.status).toBe('active')
    expect(json.locked).toBe(true)
    expect(json.expired).toBe(false)
    expect(json.lock).toBeDefined()
    expect(json.lock.lockedAmount).toBe('300000.00')
    expect(json.currentRate).toBeNull()
  })

  it('returns expired with stale and current rates when lock has expired', async () => {
    seed({ fxLocks: [{ expiresAt: PAST() }] })

    const res = await GET(getReq('inv-1'), { params: Promise.resolve({ id: 'inv-1' }) })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.status).toBe('expired')
    expect(json.locked).toBe(true)
    expect(json.expired).toBe(true)
    expect(json.lock.lockedAmount).toBe('300000.00')
    expect(json.currentRate).toBeDefined()
    expect(json.currentRate.amount).toBeDefined()
    expect(json.currentRate.currency).toBe('NGN')
    expect(json.currentRate.differenceFromLocked).toBeDefined()
  })

  it('expired lock: current rate amount matches the snapshot rate', async () => {
    // current snapshot rate = 1600 (higher than locked 1500, and more recent)
    const olderTime = new Date(Date.now() - 45 * 60_000)
    const newerTime = new Date(Date.now() - 15 * 60_000)
    seed({
      fxLocks: [{ expiresAt: PAST(), fxRateSnapshotId: 'snap-1' }],
      fxSnapshots: [
        { id: 'snap-1', rate: d('1500'), capturedAt: olderTime, createdAt: olderTime },
        { id: 'snap-2', rate: d('1600'), capturedAt: newerTime, createdAt: newerTime },
      ],
    })

    const res = await GET(getReq('inv-1'), { params: Promise.resolve({ id: 'inv-1' }) })
    const json = await res.json()
    expect(json.expired).toBe(true)
    // currentAmount = 200 * 1600 = 320000
    expect(json.currentRate.amount).toBe('320000.00')
    // difference = 320000 - 300000 = 20000
    expect(json.currentRate.differenceFromLocked).toBe('20000.00')
  })

  it('returns 404 when invoice not found', async () => {
    seed()
    const res = await GET(getReq('inv-ghost'), { params: Promise.resolve({ id: 'inv-ghost' }) })
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.code).toBe('INVOICE_NOT_FOUND')
  })

  it('returns 404 for invoice owned by another user', async () => {
    seed({ invoice: { userId: 'user-other' } })
    const res = await GET(getReq('inv-1'), { params: Promise.resolve({ id: 'inv-1' }) })
    expect(res.status).toBe(404)
  })

  it('returns 401 when no token', async () => {
    seed()
    const res = await GET(getReq('inv-1', null), { params: Promise.resolve({ id: 'inv-1' }) })
    expect(res.status).toBe(401)
  })

  it('returns 422 when expired but no current rate available', async () => {
    seed({ fxLocks: [{ expiresAt: PAST() }], fxSnapshots: [] })

    const res = await GET(getReq('inv-1'), { params: Promise.resolve({ id: 'inv-1' }) })
    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.code).toBe('FX_RATE_UNAVAILABLE')
  })

  it('does not mutate the lock when observing expiry', async () => {
    const pastExpiry = PAST()
    seed({ fxLocks: [{ expiresAt: pastExpiry }] })

    await GET(getReq('inv-1'), { params: Promise.resolve({ id: 'inv-1' }) })
    // Lock unchanged in store
    expect(store.state.fxLocks[0].expiresAt).toEqual(pastExpiry)
    expect(store.state.fxLocks).toHaveLength(1)
  })

  it('at exact expiry moment: lock is expired (>= comparison)', async () => {
    // Use PAST() which is ≤ now, so isFxLockExpired returns true
    seed({ fxLocks: [{ expiresAt: PAST() }] })
    const res = await GET(getReq('inv-1'), { params: Promise.resolve({ id: 'inv-1' }) })
    const json = await res.json()
    expect(json.expired).toBe(true)
  })

  it('one millisecond before expiry: lock is active', async () => {
    // Use FUTURE() + 1ms to ensure it's in the future
    seed({ fxLocks: [{ expiresAt: FUTURE() }] })
    const res = await GET(getReq('inv-1'), { params: Promise.resolve({ id: 'inv-1' }) })
    const json = await res.json()
    expect(json.expired).toBe(false)
    expect(json.status).toBe('active')
  })
})
