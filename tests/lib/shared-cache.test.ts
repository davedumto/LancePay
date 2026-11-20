import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SharedCache } from '@/lib/shared-cache'

describe('SharedCache bounds (#1882)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('evicts the least-recently-used key when the size cap is exceeded', () => {
    const cache = new SharedCache({ maxSize: 3 })
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)
    cache.get('a') // refresh 'a' — 'b' is now oldest
    cache.set('d', 4)

    expect(cache.get('b')).toBeNull()
    expect(cache.get('a')).toBe(1)
    expect(cache.get('c')).toBe(3)
    expect(cache.get('d')).toBe(4)
    expect(cache.stats().evicted).toBe(1)
  })

  it('sweeps expired entries during writes on a bounded schedule', () => {
    const cache = new SharedCache({ sweepIntervalMs: 1000 })
    cache.set('old', 1, 500)
    cache.set('fresh', 2)

    vi.advanceTimersByTime(600)
    // Within sweep interval — expired key still lazily removed on read
    expect(cache.get('old')).toBeNull()

    cache.set('expiring', 3, 100)
    vi.advanceTimersByTime(1100) // past sweep interval and TTL
    cache.set('trigger', 4) // write triggers the sweep

    const stats = cache.stats()
    expect(stats.size).toBe(2) // 'fresh' + 'trigger'; 'expiring' swept
    expect(cache.has('expiring')).toBe(false)
  })

  it('does not sweep more often than the configured interval', () => {
    const cache = new SharedCache({ sweepIntervalMs: 50 })
    cache.set('a', 1, 10)
    vi.advanceTimersByTime(100)
    cache.set('b', 2) // sweep interval elapsed — 'a' is swept
    expect(cache.stats().evicted).toBe(1)

    cache.set('c', 3, 10)
    vi.advanceTimersByTime(100)
    cache.set('d', 4) // interval elapsed again — 'c' swept too
    expect(cache.stats().evicted).toBe(2)
    expect(cache.has('c')).toBe(false) // and lazy expiry still applies
  })

  it('exposes size and hit/miss counters', () => {
    const cache = new SharedCache()
    cache.set('a', 1)
    cache.get('a')
    cache.get('a')
    cache.get('missing')

    const stats = cache.stats()
    expect(stats.size).toBe(1)
    expect(stats.hits).toBe(2)
    expect(stats.misses).toBe(1)
  })
})

describe('SharedCache null semantics (#1883)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('has() returns true for a stored null value', () => {
    const cache = new SharedCache()
    cache.set('negative', null)
    expect(cache.has('negative')).toBe(true)
    expect(cache.getEntry('negative')).toEqual({ found: true, value: null })
  })

  it('getEntry distinguishes stored undefined from a missing key', () => {
    const cache = new SharedCache()
    cache.set('undef', undefined)
    expect(cache.getEntry('undef').found).toBe(true)
    expect(cache.getEntry('missing')).toEqual({ found: false })
  })

  it('reports found:false for expired and missing keys', () => {
    const cache = new SharedCache()
    cache.set('expired', 1, 100)
    vi.advanceTimersByTime(200)

    expect(cache.getEntry('expired').found).toBe(false)
    expect(cache.getEntry('never-set').found).toBe(false)
    expect(cache.has('expired')).toBe(false)
  })

  it('get still returns null for missing, expired and stored-null keys', () => {
    const cache = new SharedCache()
    cache.set('nullval', null)
    cache.set('exp', 1, 50)
    vi.advanceTimersByTime(100)

    expect(cache.get('nullval')).toBeNull()
    expect(cache.get('exp')).toBeNull()
    expect(cache.get('missing')).toBeNull()
  })
})
