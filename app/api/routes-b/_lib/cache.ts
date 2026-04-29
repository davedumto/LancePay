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