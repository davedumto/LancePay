import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { Decimal } from '@prisma/client/runtime/library'

// ---------------------------------------------------------------------------
// Prisma in-memory store
// ---------------------------------------------------------------------------

interface UserRow { id: string; privyId: string; homeCurrency: string }
interface ProjectRow { id: string; userId: string }
interface ExpenseRow {
  id: string; userId: string; category: string; description: string
  amount: Decimal; currency: string; expenseDate: Date
  projectId: string | null; receiptUrl: string | null
  reimbursementMatch: { id: string } | null
}
interface FxSnapshotRow {
  id: string; fromCurrency: string; toCurrency: string
  rate: Decimal; source: string; capturedAt: Date; createdAt: Date
}

interface Store {
  users: Map<string, UserRow>
  projects: Map<string, ProjectRow>
  expenses: Map<string, ExpenseRow>
  fxSnapshots: FxSnapshotRow[]
}

const store = vi.hoisted((): { state: Store } => ({
  state: {
    users: new Map(),
    projects: new Map(),
    expenses: new Map(),
    fxSnapshots: [],
  },
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
    project: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; userId: string } }) => {
        const p = store.state.projects.get(where.id)
        return p && p.userId === where.userId ? p : null
      }),
    },
    expense: {
      findMany: vi.fn(async ({ where }: {
        where: { userId: string; reimbursementMatch: { is: null }; projectId?: string }
      }) => {
        return [...store.state.expenses.values()].filter(e => {
          if (e.userId !== where.userId) return false
          if (e.reimbursementMatch !== null) return false
          if (where.projectId !== undefined && e.projectId !== where.projectId) return false
          return true
        })
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

function seed(overrides: {
  user?: Partial<UserRow>
  projects?: Partial<ProjectRow>[]
  expenses?: Partial<ExpenseRow>[]
  fxSnapshots?: Partial<FxSnapshotRow>[]
} = {}) {
  const user: UserRow = {
    id: 'user-1', privyId: 'privy-1', homeCurrency: 'NGN',
    ...overrides.user,
  }
  store.state.users.set(user.id, user)
  ;(prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(user)
  ;(verifyAuthToken as ReturnType<typeof vi.fn>).mockResolvedValue({ userId: user.privyId })

  store.state.projects = new Map(
    (overrides.projects ?? []).map((p, i) => {
      const row: ProjectRow = { id: `proj-${i + 1}`, userId: user.id, ...p }
      return [row.id, row]
    }),
  )

  const now = new Date('2026-01-15T12:00:00Z')
  store.state.expenses = new Map(
    (overrides.expenses ?? []).map((e, i) => {
      const row: ExpenseRow = {
        id: `exp-${i + 1}`, userId: user.id, category: 'travel',
        description: 'taxi', amount: d('100.00'), currency: 'USD',
        expenseDate: now, projectId: null, receiptUrl: null,
        reimbursementMatch: null, ...e,
      }
      return [row.id, row]
    }),
  )

  store.state.fxSnapshots = (overrides.fxSnapshots ?? []).map((s, i) => ({
    id: `snap-${i + 1}`, fromCurrency: 'USD', toCurrency: 'NGN',
    rate: d('1500'), source: 'test', capturedAt: now, createdAt: now, ...s,
  }))
}

function req(token: string | null = 'tok', params: Record<string, string> = {}) {
  const url = new URL('http://localhost/api/expenses/unreimbursed')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return new NextRequest(url.toString(), {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('GET /api/expenses/unreimbursed', () => {
  beforeEach(() => {
    store.state = {
      users: new Map(), projects: new Map(), expenses: new Map(), fxSnapshots: [],
    }
    vi.clearAllMocks()
  })

  it('returns unreimbursed expenses with historical and current conversions', async () => {
    // historical = 2 days ago, current = 30 min ago (both in the past)
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000)
    const thirtyMinAgo = new Date(Date.now() - 30 * 60_000)
    const expenseDate = new Date(twoDaysAgo.getTime() + 60_000) // 1 min after historical snap
    const historicalSnap: Partial<FxSnapshotRow> = {
      id: 'snap-hist', rate: d('1400'), capturedAt: twoDaysAgo,
    }
    const currentSnap: Partial<FxSnapshotRow> = {
      id: 'snap-cur', rate: d('1500'), capturedAt: thirtyMinAgo,
    }
    seed({
      expenses: [{ amount: d('100.00'), currency: 'USD', expenseDate }],
      fxSnapshots: [historicalSnap, currentSnap],
    })

    const res = await GET(req())
    expect(res.status).toBe(200)
    const json = await res.json()

    expect(json.homeCurrency).toBe('NGN')
    expect(json.expenses).toHaveLength(1)

    const exp = json.expenses[0]
    // historical: 100 * 1400 = 140000
    expect(exp.converted.atIncurred.amount).toBe('140000.00')
    // current: 100 * 1500 = 150000
    expect(exp.converted.atCurrentRate.amount).toBe('150000.00')
    expect(exp.converted.difference).toBe('10000.00')
    expect(exp.converted.currency).toBe('NGN')
  })

  it('excludes expenses with a reimbursement match', async () => {
    const now = new Date('2026-01-15T12:00:00Z')
    seed({
      expenses: [
        { id: 'exp-1', reimbursementMatch: null },
        { id: 'exp-2', reimbursementMatch: { id: 'match-1' } },
      ],
      fxSnapshots: [{ rate: d('1500'), capturedAt: now }],
    })

    const res = await GET(req())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.expenses).toHaveLength(1)
    expect(json.expenses[0].id).toBe('exp-1')
  })

  it('filters by projectId', async () => {
    const now = new Date('2026-01-15T12:00:00Z')
    seed({
      projects: [{ id: 'proj-1' }],
      expenses: [
        { id: 'exp-1', projectId: 'proj-1' },
        { id: 'exp-2', projectId: 'proj-2' },
        { id: 'exp-3', projectId: null },
      ],
      fxSnapshots: [{ rate: d('1500'), capturedAt: now }],
    })

    const res = await GET(req('tok', { projectId: 'proj-1' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.expenses).toHaveLength(1)
    expect(json.expenses[0].id).toBe('exp-1')
    expect(json.projectId).toBe('proj-1')
  })

  it('rejects project not owned by user', async () => {
    seed({ projects: [] })
    const res = await GET(req('tok', { projectId: 'proj-other' }))
    expect(res.status).toBe(404)
  })

  it('returns 401 when no token', async () => {
    seed()
    const res = await GET(req(null))
    expect(res.status).toBe(401)
  })

  it('returns 401 for invalid token', async () => {
    seed()
    ;(verifyAuthToken as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null)
    const res = await GET(req('bad'))
    expect(res.status).toBe(401)
  })

  it('returns 404 when user not found', async () => {
    ;(verifyAuthToken as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ userId: 'privy-ghost' })
    ;(prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null)
    const res = await GET(req())
    expect(res.status).toBe(404)
  })

  it('returns 400 when projectId is empty string', async () => {
    seed()
    const res = await GET(req('tok', { projectId: '' }))
    expect(res.status).toBe(400)
  })

  it('returns 422 when FX rate is missing', async () => {
    seed({
      expenses: [{ currency: 'USD', expenseDate: new Date('2026-01-10T00:00:00Z') }],
      fxSnapshots: [], // no snapshots
    })

    const res = await GET(req())
    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.code).toBe('FX_RATE_UNAVAILABLE')
  })

  it('returns same-currency expense without FX snapshot', async () => {
    seed({
      expenses: [{ amount: d('5000.00'), currency: 'NGN' }],
      fxSnapshots: [],
    })

    const res = await GET(req())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.expenses[0].converted.atIncurred.amount).toBe('5000.00')
    expect(json.expenses[0].converted.atCurrentRate.amount).toBe('5000.00')
  })

  it('aggregates totals across multiple expenses', async () => {
    const now = new Date('2026-01-15T12:00:00Z')
    seed({
      expenses: [
        { amount: d('100.00'), currency: 'USD', expenseDate: now },
        { amount: d('200.00'), currency: 'USD', expenseDate: now },
      ],
      fxSnapshots: [{ rate: d('1500'), capturedAt: now }],
    })

    const res = await GET(req())
    const json = await res.json()
    // 100*1500 + 200*1500 = 450000
    expect(json.totals.count).toBe(2)
    expect(json.totals.atCurrentRate).toBe('450000.00')
  })

  it('returns empty list with zero totals when all expenses are matched', async () => {
    const now = new Date('2026-01-15T12:00:00Z')
    seed({
      expenses: [{ reimbursementMatch: { id: 'match-1' } }],
      fxSnapshots: [{ rate: d('1500'), capturedAt: now }],
    })

    const res = await GET(req())
    const json = await res.json()
    expect(json.expenses).toHaveLength(0)
    expect(json.totals.count).toBe(0)
  })
})
