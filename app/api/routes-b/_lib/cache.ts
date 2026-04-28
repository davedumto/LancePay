type CacheEntry<T> = {
  value: T
  expiresAt: number
}

const store = new Map<string, CacheEntry<unknown>>()

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

