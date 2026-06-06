type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

const store = new Map<string, CacheEntry<unknown>>();

/**
 * Get a cached value by key.
 *
 * Time Complexity: O(1) - Map lookup
 * Space Complexity: O(1) - No additional space
 *
 * Returns null if key doesn't exist or value has expired.
 * Automatically deletes expired entries on access.
 */
export function getCacheValue<T>(key: string): T | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value as T;
}

/**
 * Set a cached value with TTL.
 *
 * Time Complexity: O(1) - Map insertion
 * Space Complexity: O(1) - Single entry
 *
 * @param key - Cache key
 * @param value - Value to cache
 * @param ttlMs - Time to live in milliseconds
 */
export function setCacheValue<T>(key: string, value: T, ttlMs: number): void {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/**
 * Delete a cached value.
 *
 * Time Complexity: O(1) - Map deletion
 * Space Complexity: O(1) - No additional space
 */
export function deleteCacheValue(key: string): void {
  store.delete(key);
}

/**
 * Clear all cached values.
 *
 * Time Complexity: O(n) where n is number of cached entries
 * Space Complexity: O(1) - No additional space
 */
export function clearCache(): void {
  store.clear();
}
/**
 * Get a cached value by key (alias for getCacheValue).
 *
 * Time Complexity: O(1) - Map lookup
 * Space Complexity: O(1) - No additional space
 */
export function getCachedValue<T>(key: string): T | null {
  const entry = store.get(key);
  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    store.delete(key);
    return null;
  }

  return entry.value as T;
}

/**
 * Set a cached value with TTL (alias for setCacheValue).
 *
 * Time Complexity: O(1) - Map insertion
 * Space Complexity: O(1) - Single entry
 */
export function setCachedValue<T>(key: string, value: T, ttlMs: number) {
  store.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

/**
 * Delete a cached value (alias for deleteCacheValue).
 *
 * Time Complexity: O(1) - Map deletion
 * Space Complexity: O(1) - No additional space
 */
export function deleteCachedValue(key: string) {
  store.delete(key);
}
