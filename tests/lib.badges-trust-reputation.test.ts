import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({ prisma: {} }))

import { calculateUserTrustScore, isTrustScoreStale, recomputeUserTrustScore, TRUST_SCORE_TTL_MS } from '@/lib/trust-score'
import { calculateClientReputation } from '@/lib/client-reputation'
import { meetsBadgeCriteria, parseBadgeCriteria } from '@/lib/badges'

describe('calculateUserTrustScore', () => {
  const base = { paid: 0, decided: 0, disputes: 0, accountAgeDays: 0 }

  it('scores a brand-new account with no history as 55 without dividing by zero', () => {
    expect(calculateUserTrustScore(base)).toBe(55)
  })

  it('combines completion, disputes and account age', () => {
    // 50*(8+1)/(10+2)=37.5 + (30-6)=24 + 20*(182.5/365)=10 → 71.5 → 72
    expect(calculateUserTrustScore({ paid: 8, decided: 10, disputes: 1, accountAgeDays: 182.5 })).toBe(72)
  })

  it('does not let a single invoice pin the completion component', () => {
    const oneFailed = calculateUserTrustScore({ ...base, decided: 1 })
    const onePaid = calculateUserTrustScore({ ...base, paid: 1, decided: 1 })
    expect(oneFailed).toBeGreaterThan(30 + 0)
    expect(onePaid).toBeLessThan(50 + 30)
  })

  it('lowers the score by 6 per dispute until the component is exhausted', () => {
    const clean = calculateUserTrustScore({ ...base, disputes: 0 })
    expect(calculateUserTrustScore({ ...base, disputes: 1 })).toBe(clean - 6)
    expect(calculateUserTrustScore({ ...base, disputes: 5 })).toBe(clean - 30)
    expect(calculateUserTrustScore({ ...base, disputes: 500 })).toBe(clean - 30)
  })

  it('ramps account age linearly to full credit at one year', () => {
    expect(calculateUserTrustScore({ ...base, accountAgeDays: 365 }) - calculateUserTrustScore(base)).toBe(20)
    expect(calculateUserTrustScore({ ...base, accountAgeDays: 5000 })).toBe(calculateUserTrustScore({ ...base, accountAgeDays: 365 }))
    expect(calculateUserTrustScore({ ...base, accountAgeDays: -10 })).toBe(calculateUserTrustScore(base))
  })

  it('stays within 0–100 at the extremes and on inconsistent input', () => {
    const best = calculateUserTrustScore({ paid: 1e6, decided: 1e6, disputes: 0, accountAgeDays: 1e5 })
    const worst = calculateUserTrustScore({ paid: 0, decided: 1e6, disputes: 1e6, accountAgeDays: 0 })
    const garbage = calculateUserTrustScore({ paid: 10, decided: 2, disputes: -3, accountAgeDays: 1 })
    for (const score of [best, worst, garbage]) {
      expect(Number.isInteger(score)).toBe(true)
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(100)
    }
    expect(best).toBe(100)
    expect(worst).toBe(0)
  })
})

describe('isTrustScoreStale', () => {
  it('treats scores older than the TTL as stale', () => {
    const now = new Date('2026-09-25T12:00:00Z')
    expect(isTrustScoreStale(new Date(now.getTime() - TRUST_SCORE_TTL_MS + 1), now)).toBe(false)
    expect(isTrustScoreStale(new Date(now.getTime() - TRUST_SCORE_TTL_MS), now)).toBe(true)
  })
})

describe('recomputeUserTrustScore concurrency', () => {
  // In-memory stand-in honouring the conditional-update and unique-key semantics.
  function fakeDb(counts: { paid: number; total: number }) {
    let row: any = null
    const db: any = {
      invoice: {
        count: vi.fn(async (args: any) =>
          args.where.status === 'paid' ? counts.paid : args.where.status === 'pending' ? 0 : counts.total),
      },
      dispute: { count: vi.fn(async () => 0) },
      userTrustScore: {
        updateMany: vi.fn(async ({ where, data }: any) => {
          if (!row || !(row.lastUpdatedAt < where.lastUpdatedAt.lt)) return { count: 0 }
          row = { ...row, ...data }
          return { count: 1 }
        }),
        create: vi.fn(async ({ data }: any) => {
          if (row) throw Object.assign(new Error('Unique constraint'), { code: 'P2002' })
          row = { ...data }
          return row
        }),
        findUniqueOrThrow: vi.fn(async () => row),
      },
    }
    return { db, get: () => row, counts }
  }

  const user = { id: 'user-1', createdAt: new Date('2025-01-01T00:00:00Z') }

  it('never lets an older computation overwrite a newer one', async () => {
    const store = fakeDb({ paid: 10, total: 10 })
    const later = new Date('2026-09-25T12:00:05Z')
    const earlier = new Date('2026-09-25T12:00:00Z')

    const newer = await recomputeUserTrustScore(user, later, store.db)
    store.counts.paid = 0
    const stale = await recomputeUserTrustScore(user, earlier, store.db)

    expect(stale).toEqual(newer)
    expect(store.get().lastUpdatedAt).toEqual(later)
    expect(store.get().successfulInvoices).toBe(10)
  })

  it('lets a later computation replace an older row', async () => {
    const store = fakeDb({ paid: 1, total: 10 })
    await recomputeUserTrustScore(user, new Date('2026-09-25T10:00:00Z'), store.db)
    store.counts.paid = 10
    const refreshed = await recomputeUserTrustScore(user, new Date('2026-09-25T12:00:00Z'), store.db)
    expect(refreshed.successfulInvoices).toBe(10)
  })

  it('resolves two simultaneous first computations to a single row', async () => {
    const store = fakeDb({ paid: 3, total: 4 })
    const now = new Date('2026-09-25T12:00:00Z')
    const [a, b] = await Promise.all([
      recomputeUserTrustScore(user, now, store.db),
      recomputeUserTrustScore(user, now, store.db),
    ])
    expect(a).toEqual(b)
    expect(store.db.userTrustScore.create).toHaveBeenCalledTimes(2)
  })
})

describe('calculateClientReputation', () => {
  it('is neutral (50) with no history', () => {
    expect(calculateClientReputation({ onTime: 0, late: 0, disputed: 0 })).toBe(50)
  })

  it('ranks on-time above late above disputed', () => {
    const onTime = calculateClientReputation({ onTime: 5, late: 0, disputed: 0 })
    const late = calculateClientReputation({ onTime: 0, late: 5, disputed: 0 })
    const disputed = calculateClientReputation({ onTime: 0, late: 0, disputed: 5 })
    expect(onTime).toBeGreaterThan(late)
    expect(late).toBeGreaterThan(disputed)
    expect(late).toBe(50)
  })

  it('stays within 0–100', () => {
    expect(calculateClientReputation({ onTime: 1e6, late: 0, disputed: 0 })).toBe(100)
    expect(calculateClientReputation({ onTime: 0, late: 0, disputed: 1e6 })).toBe(0)
    expect(calculateClientReputation({ onTime: -5, late: -5, disputed: -5 })).toBe(50)
  })
})

describe('badge criteria', () => {
  const signals = { totalRevenue: 12000, paidInvoices: 20, decidedInvoices: 25, disputeCount: 1 }

  it('parses the documented criteria shapes and rejects the rest', () => {
    expect(parseBadgeCriteria({ type: 'revenue', minRevenue: 10000 })).toEqual({ type: 'revenue', minRevenue: 10000 })
    expect(parseBadgeCriteria({ type: 'custom', customQuery: 'DROP TABLE' })).toBeNull()
    expect(parseBadgeCriteria({ type: 'invoices' })).toBeNull()
    expect(parseBadgeCriteria({ type: 'invoices', minInvoices: -1 })).toBeNull()
    expect(parseBadgeCriteria({ type: 'revenue', minRevenue: '100' })).toBeNull()
    expect(parseBadgeCriteria(null)).toBeNull()
  })

  it('evaluates each criteria type against the signals', () => {
    expect(meetsBadgeCriteria({ type: 'revenue', minRevenue: 10000 }, signals)).toBe(true)
    expect(meetsBadgeCriteria({ type: 'revenue', minRevenue: 100000 }, signals)).toBe(false)
    expect(meetsBadgeCriteria({ type: 'invoices', minInvoices: 20 }, signals)).toBe(true)
    expect(meetsBadgeCriteria({ type: 'zero_disputes', minInvoices: 10, maxDisputes: 0 }, signals)).toBe(false)
    expect(meetsBadgeCriteria({ type: 'zero_disputes', minInvoices: 10, maxDisputes: 1 }, signals)).toBe(true)
    expect(meetsBadgeCriteria({ type: 'completion_rate', minInvoices: 25, minCompletionRate: 80 }, signals)).toBe(true)
    expect(meetsBadgeCriteria({ type: 'completion_rate', minInvoices: 25, minCompletionRate: 81 }, signals)).toBe(false)
    expect(meetsBadgeCriteria({ type: 'completion_rate', minInvoices: 0, minCompletionRate: 0 }, { ...signals, decidedInvoices: 0 })).toBe(false)
  })
})
