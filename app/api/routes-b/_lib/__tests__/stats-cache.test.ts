import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearCache } from '../cache'
import {
  STATS_CACHE_TTL_MS,
  bustStatsCache,
  ensureStatsCacheInvalidationHooks,
  getCachedStats,
  setCachedStats,
  statsCacheKey,
} from '../stats-cache'
import { emitInvoicePaid, emitStatsInvalidated } from '../events'

describe('stats-cache', () => {
  beforeEach(() => {
    clearCache()
    vi.useRealTimers()
  })

  it('uses a 60 second TTL per user', () => {
    expect(STATS_CACHE_TTL_MS).toBe(60_000)
    expect(statsCacheKey('user-1')).toBe('routes-b:stats:user-1')
    expect(statsCacheKey('user-2')).toBe('routes-b:stats:user-2')
  })

  it('expires entries after TTL', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))

    setCachedStats('user-1', { totalEarned: 10 })
    expect(getCachedStats('user-1')).toEqual({ totalEarned: 10 })

    vi.advanceTimersByTime(STATS_CACHE_TTL_MS + 1)
    expect(getCachedStats('user-1')).toBeNull()
  })

  it('invalidates on emitStatsInvalidated and emitInvoicePaid hooks', () => {
    ensureStatsCacheInvalidationHooks()
    setCachedStats('user-1', { totalEarned: 1 })
    setCachedStats('user-2', { totalEarned: 2 })

    emitStatsInvalidated({ userId: 'user-1' })
    expect(getCachedStats('user-1')).toBeNull()
    expect(getCachedStats('user-2')).toEqual({ totalEarned: 2 })

    setCachedStats('user-1', { totalEarned: 3 })
    emitInvoicePaid({ userId: 'user-1', invoiceId: 'inv-1' })
    expect(getCachedStats('user-1')).toBeNull()
  })

  it('bustStatsCache removes only the targeted user', () => {
    setCachedStats('user-1', { totalEarned: 1 })
    setCachedStats('user-2', { totalEarned: 2 })

    bustStatsCache('user-1')
    expect(getCachedStats('user-1')).toBeNull()
    expect(getCachedStats('user-2')).toEqual({ totalEarned: 2 })
  })
})
