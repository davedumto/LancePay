type CacheEntry<T> = {
  value: T
  expiresAt: number
}

const store = new Map<string, CacheEntry<unknown>>()

export function getCacheValue<T>(key: string): T | null {
  const entry = store.get(key)
  if (!entry) return null
  if (Date.now() >= entry.expiresAt) {
    store.delete(key)
    return null
  }
  return entry.value as T
}

export function setCacheValue<T>(key: string, value: T, ttlMs: number): void {
  store.set(key, { value, expiresAt: Date.now() + ttlMs })
}

export function deleteCacheValue(key: string): void {
  store.delete(key)
}

export function clearCache(): void {
  store.clear()
}
export function getCachedValue<T>(key: string): T | null {
  const entry = store.get(key)
  if (!entry) {
    return null
  }

  if (entry.expiresAt <= Date.now()) {
    store.delete(key)
    return null
  }

  return entry.value as T
}

export function setCachedValue<T>(key: string, value: T, ttlMs: number) {
  store.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  })
}

export function deleteCachedValue(key: string) {
  store.delete(key)
}

