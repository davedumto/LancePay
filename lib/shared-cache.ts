export interface CacheEntry<T = unknown> {
  value: T
  expiresAt?: number
}

export class SharedCache {
  private store = new Map<string, CacheEntry>()

  set<T>(key: string, value: T, ttlMs?: number): void {
    const expiresAt = ttlMs ? Date.now() + ttlMs : undefined
    this.store.set(key, { value, expiresAt })
  }

  get<T>(key: string): T | null {
    const entry = this.store.get(key)
    if (!entry) return null
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key)
      return null
    }
    return entry.value as T
  }

  delete(key: string): boolean {
    return this.store.delete(key)
  }

  clear(): void {
    this.store.clear()
  }

  has(key: string): boolean {
    return this.get(key) !== null
  }
}

export const sharedCache = new SharedCache()
