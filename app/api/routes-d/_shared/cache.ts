type CacheEntry<T> = {
  data: T
  timestamp: number
}

// In-memory cache mapping userId -> CacheEntry
const dashboardCache = new Map<string, CacheEntry<unknown>>()
const TTL_MS = 30 * 1000 // 30 seconds

/**
 * Retrieves the cached dashboard data for a given user, or null if not found or expired.
 */
export function getCachedDashboard(userId: string): unknown | null {
  const entry = dashboardCache.get(userId)
  if (!entry) return null

  if (Date.now() - entry.timestamp > TTL_MS) {
    dashboardCache.delete(userId)
    return null
  }
  return entry.data
}

/**
 * Caches the dashboard data for a user.
 */
export function setCachedDashboard(userId: string, data: unknown): void {
  dashboardCache.set(userId, {
    data,
    timestamp: Date.now(),
  })
}

/**
 * Invalidates (deletes) the cached dashboard data for a user.
 */
export function invalidateDashboardCache(userId: string): void {
  dashboardCache.delete(userId)
}

/**
 * Clears all entries in the dashboard cache (primarily for unit tests).
 */
export function clearDashboardCache(): void {
  dashboardCache.clear()
}
