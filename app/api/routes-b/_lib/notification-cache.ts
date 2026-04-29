import { deleteCacheValue, getCacheValue, setCacheValue } from './cache'

const UNREAD_COUNT_TTL_MS = 10_000

function unreadCountCacheKey(userId: string) {
  return `notifications:unread-count:${userId}`
}

export function getCachedUnreadCount(userId: string): number | null {
  return getCacheValue<number>(unreadCountCacheKey(userId))
}

export function setCachedUnreadCount(userId: string, count: number) {
  setCacheValue(unreadCountCacheKey(userId), count, UNREAD_COUNT_TTL_MS)
}

export function bustUnreadCountCache(userId: string) {
  deleteCacheValue(unreadCountCacheKey(userId))
}
