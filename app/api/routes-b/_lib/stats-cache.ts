import { deleteCacheValue, getCacheValue, setCacheValue } from './cache'
import { onInvoicePaid, onStatsInvalidated } from './events'

export const STATS_CACHE_TTL_MS = 60_000

export function statsCacheKey(userId: string): string {
  return `routes-b:stats:${userId}`
}

export function getCachedStats<T>(userId: string): T | null {
  return getCacheValue<T>(statsCacheKey(userId))
}

export function setCachedStats<T>(userId: string, value: T): void {
  setCacheValue(statsCacheKey(userId), value, STATS_CACHE_TTL_MS)
}

export function bustStatsCache(userId: string): void {
  deleteCacheValue(statsCacheKey(userId))
}

let statsCacheInvalidationHooked = false

export function ensureStatsCacheInvalidationHooks(): void {
  if (statsCacheInvalidationHooked) return
  statsCacheInvalidationHooked = true

  onStatsInvalidated(({ userId }) => {
    bustStatsCache(userId)
  })

  onInvoicePaid(({ userId }) => {
    bustStatsCache(userId)
  })
}
