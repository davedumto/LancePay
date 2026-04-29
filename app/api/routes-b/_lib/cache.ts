<<<<<<< HEAD
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

=======
import { prisma } from '@/lib/db';

const CACHE_TTL = 30 * 1000; // 30 seconds
const tagListCache = new Map<string, { data: any; expires: number }>();

export async function getCachedTags(userId: string) {
  const cacheKey = `tags-list:${userId}`;
  const cached = tagListCache.get(cacheKey);

  if (cached && cached.expires > Date.now()) {
    return cached.data;
  }

  return null;
}

export function setCachedTags(userId: string, data: any) {
  const cacheKey = `tags-list:${userId}`;
  tagListCache.set(cacheKey, {
    data,
    expires: Date.now() + CACHE_TTL,
  });
}

export function invalidateTagsCache(userId: string) {
  const cacheKey = `tags-list:${userId}`;
  tagListCache.delete(cacheKey);
}
>>>>>>> 7added4 (feat(routes-b): add usageCount to tags GET endpoint with caching)
