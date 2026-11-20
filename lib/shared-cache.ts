export interface CacheEntry<T = unknown> {
  value: T
  expiresAt?: number
}

export interface SharedCacheOptions {
  /** Maximum number of entries before LRU eviction. Default 1000. */
  maxSize?: number
  /**
   * Minimum interval between expiry sweeps during writes. Default 60s.
   * Sweeping on every write would make hot write paths O(n).
   */
  sweepIntervalMs?: number
}

export interface SharedCacheStats {
  /** Live entries currently stored. */
  size: number
  hits: number
  misses: number
  /** Entries evicted by the size cap or expiry sweep. */
  evicted: number
}

const DEFAULT_MAX_SIZE = 1000
const DEFAULT_SWEEP_INTERVAL_MS = 60_000

/**
 * In-process shared cache with optional per-entry TTL.
 *
 * - Bounded: at most `maxSize` entries; overflow evicts the
 *   least-recently-used key (Map insertion order is refreshed on read).
 * - Expired entries are removed lazily on read AND swept periodically
 *   during writes (at most once per `sweepIntervalMs`), so keys written
 *   once and never read cannot accumulate for the life of the instance.
 * - `stats()` exposes size and hit/miss counters for monitoring.
 *
 * Note: `get`/`has` return `null`/`false` for missing keys, expired keys,
 * AND keys whose stored value is `null` — a stored `null` is a hit for
 * `has` but indistinguishable from a miss through `get`. Use `getEntry`
 * when the found flag matters.
 */
export class SharedCache {
  private store = new Map<string, CacheEntry>()
  private readonly maxSize: number
  private readonly sweepIntervalMs: number
  private lastSweepAt = 0
  private hits = 0
  private misses = 0
  private evicted = 0

  constructor(options: SharedCacheOptions = {}) {
    this.maxSize = options.maxSize ?? DEFAULT_MAX_SIZE
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS
  }

  set<T>(key: string, value: T, ttlMs?: number): void {
    const now = Date.now()
    this.sweepExpired(now)

    // Refresh recency: delete-then-set moves the key to the newest slot.
    this.store.delete(key)
    this.store.set(key, {
      value,
      expiresAt: ttlMs ? now + ttlMs : undefined,
    })
    this.evictOverflow()
  }

  get<T>(key: string): T | null {
    const entry = this.store.get(key)
    if (!entry || this.isExpired(entry)) {
      this.store.delete(key)
      this.misses++
      return null
    }
    // LRU refresh
    this.store.delete(key)
    this.store.set(key, entry)
    this.hits++
    return entry.value as T
  }

  /**
   * Returns the raw map entry together with a `found` flag. Unlike `get`,
   * this distinguishes "key absent/expired" from "key present with a
   * null/undefined value" — use it for negative-result caching.
   */
  getEntry<T>(key: string): { found: boolean; value?: T } {
    const entry = this.store.get(key)
    if (!entry || this.isExpired(entry)) {
      this.store.delete(key)
      this.misses++
      return { found: false }
    }
    this.store.delete(key)
    this.store.set(key, entry)
    this.hits++
    return { found: true, value: entry.value as T }
  }

  delete(key: string): boolean {
    return this.store.delete(key)
  }

  clear(): void {
    this.store.clear()
    this.hits = 0
    this.misses = 0
    this.evicted = 0
  }

  has(key: string): boolean {
    return this.getEntry(key).found
  }

  /** Current size and hit/miss/eviction counters for monitoring. */
  stats(): SharedCacheStats {
    return {
      size: this.store.size,
      hits: this.hits,
      misses: this.misses,
      evicted: this.evicted,
    }
  }

  private isExpired(entry: CacheEntry): boolean {
    return entry.expiresAt !== undefined && Date.now() > entry.expiresAt
  }

  private sweepExpired(now: number): void {
    if (now - this.lastSweepAt < this.sweepIntervalMs) return
    this.lastSweepAt = now
    for (const [key, entry] of this.store) {
      if (entry.expiresAt !== undefined && now > entry.expiresAt) {
        this.store.delete(key)
        this.evicted++
      }
    }
  }

  private evictOverflow(): void {
    while (this.store.size > this.maxSize) {
      const oldest = this.store.keys().next().value
      if (oldest === undefined) break
      this.store.delete(oldest)
      this.evicted++
    }
  }
}

export const sharedCache = new SharedCache()
