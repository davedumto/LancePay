import { prisma } from './db'

export interface PersistedQueryRecord {
  hash: string
  appId: string
  query: string
  normalized?: string
  depth?: number
  complexity?: number
  accessCount: number
  createdAt: Date
  lastAccessedAt: Date
}

export interface RegisterPersistedQueryOptions {
  normalized?: string
  depth?: number
  complexity?: number
}

/**
 * Read-through cache in front of the `PersistedQuery` Prisma model.
 *
 * Registrations are written to Postgres keyed on (appId, hash) so they
 * survive serverless cold starts and are visible to every instance — the
 * previous globalThis-only store lost registrations on recycle and gave
 * different instances different views. This Map only avoids a DB round
 * trip per lookup; it is never the source of truth.
 *
 * Only positive lookups are cached (misses are not), so a registration
 * created through any path is visible on the next read without explicit
 * invalidation. `invalidatePersistedQuery` is still exported for callers
 * that update or delete rows directly.
 */
const queryCache = new Map<string, PersistedQueryRecord>()

function cacheKey(appId: string, hash: string): string {
  return `${appId}:${hash}`
}

function rowToRecord(row: {
  appId: string
  hash: string
  query: string
  normalized: string
  depth: number
  complexity: number
  createdAt: Date
  updatedAt: Date
}): PersistedQueryRecord {
  return {
    hash: row.hash,
    appId: row.appId,
    query: row.query,
    normalized: row.normalized,
    depth: row.depth,
    complexity: row.complexity,
    // Access metrics are per-instance observability, not persisted state.
    accessCount: 0,
    createdAt: row.createdAt,
    lastAccessedAt: row.updatedAt,
  }
}

/**
 * Looks up a persisted query by developer app + hash. Checks the
 * in-process cache first, then Postgres; DB hits populate the cache.
 */
export async function getPersistedQuery(
  appId: string,
  hash: string,
): Promise<PersistedQueryRecord | undefined> {
  const key = cacheKey(appId, hash)
  const cached = queryCache.get(key)
  if (cached) return cached

  const row = await prisma.persistedQuery.findUnique({
    where: { appId_hash: { appId, hash } },
  })
  if (!row) return undefined

  const record = rowToRecord(row)
  queryCache.set(key, record)
  return record
}

/**
 * Registers (or refreshes) a persisted query in Postgres and the cache.
 * `normalized`, `depth` and `complexity` default to the raw query and
 * zero metrics when the caller does not compute them.
 */
export async function registerPersistedQuery(
  appId: string,
  hash: string,
  query: string,
  options: RegisterPersistedQueryOptions = {},
): Promise<PersistedQueryRecord> {
  const now = new Date()
  const row = await prisma.persistedQuery.upsert({
    where: { appId_hash: { appId, hash } },
    create: {
      appId,
      hash,
      query,
      normalized: options.normalized ?? query,
      depth: options.depth ?? 0,
      complexity: options.complexity ?? 0,
    },
    update: {
      query,
      normalized: options.normalized ?? query,
      depth: options.depth ?? 0,
      complexity: options.complexity ?? 0,
    },
  })

  const record: PersistedQueryRecord = {
    ...rowToRecord(row),
    accessCount: 0,
    lastAccessedAt: now,
  }
  queryCache.set(cacheKey(appId, hash), record)
  return record
}

/** Drops a single entry from the read-through cache. */
export function invalidatePersistedQuery(appId: string, hash: string): void {
  queryCache.delete(cacheKey(appId, hash))
}

/**
 * Clears the in-process cache only — Postgres registrations persist.
 * Intended for tests simulating a cold start.
 */
export function resetPersistedQueryStore(): void {
  queryCache.clear()
}
