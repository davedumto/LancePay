import { describe, it, expect, beforeEach, vi } from 'vitest'

// In-memory stand-in for the PersistedQuery table, shared with the mock.
const dbStore = vi.hoisted(() => {
  const rows = new Map<string, any>()
  const key = (appId: string, hash: string) => `${appId}:${hash}`
  return {
    rows,
    key,
    findUnique: vi.fn(async ({ where }: any) => {
      const { appId, hash } = where.appId_hash
      return rows.get(key(appId, hash)) ?? null
    }),
    upsert: vi.fn(async ({ where, create, update }: any) => {
      const { appId, hash } = where.appId_hash
      const k = key(appId, hash)
      const existing = rows.get(k)
      const now = new Date()
      const row = existing
        ? { ...existing, ...update, updatedAt: now }
        : {
            id: `pq_${rows.size + 1}`,
            ...create,
            createdAt: now,
            updatedAt: now,
          }
      rows.set(k, row)
      return row
    }),
  }
})

vi.mock('@/lib/db', () => ({
  prisma: {
    persistedQuery: {
      findUnique: dbStore.findUnique,
      upsert: dbStore.upsert,
    },
  },
}))

import {
  getPersistedQuery,
  registerPersistedQuery,
  invalidatePersistedQuery,
  resetPersistedQueryStore,
} from '@/lib/persisted-queries'

describe('persisted queries store (#1884)', () => {
  beforeEach(() => {
    dbStore.rows.clear()
    vi.clearAllMocks()
    resetPersistedQueryStore()
  })

  it('registers a query and resolves it by appId + hash', async () => {
    const record = await registerPersistedQuery(
      'app_1',
      'hash_a',
      'query { user { id } }',
      { normalized: 'query { user { id } }', depth: 2, complexity: 3 },
    )

    expect(record.query).toBe('query { user { id } }')
    expect(record.depth).toBe(2)

    // Registration populated the read-through cache — served without a DB read
    const cached = await getPersistedQuery('app_1', 'hash_a')
    expect(cached?.query).toBe('query { user { id } }')
    expect(dbStore.findUnique).toHaveBeenCalledTimes(0)

    // After a cold start the same lookup falls through to Postgres once,
    // then is cached again
    resetPersistedQueryStore()
    const found = await getPersistedQuery('app_1', 'hash_a')
    expect(found?.query).toBe('query { user { id } }')
    expect(dbStore.findUnique).toHaveBeenCalledTimes(1)

    await getPersistedQuery('app_1', 'hash_a')
    expect(dbStore.findUnique).toHaveBeenCalledTimes(1)
  })

  it('scopes lookups by appId — same hash under another app is not found', async () => {
    await registerPersistedQuery('app_1', 'hash_shared', 'query A')
    expect(await getPersistedQuery('app_2', 'hash_shared')).toBeUndefined()
    expect(await getPersistedQuery('app_1', 'hash_shared')).toBeDefined()
  })

  it('survives a simulated cold start — cache cleared, DB row still resolves', async () => {
    await registerPersistedQuery('app_1', 'hash_cold', 'query { cold }')

    // Simulate instance recycle: in-process cache gone, Postgres intact
    resetPersistedQueryStore()
    // register() wrote via upsert only — no reads yet
    expect(dbStore.findUnique).toHaveBeenCalledTimes(0)

    const found = await getPersistedQuery('app_1', 'hash_cold')
    expect(found?.query).toBe('query { cold }')
    expect(dbStore.findUnique).toHaveBeenCalledWith({
      where: { appId_hash: { appId: 'app_1', hash: 'hash_cold' } },
    })
  })

  it('invalidatePersistedQuery forces a fresh DB read', async () => {
    await registerPersistedQuery('app_1', 'hash_inv', 'query V1')
    await getPersistedQuery('app_1', 'hash_inv') // populate cache

    invalidatePersistedQuery('app_1', 'hash_inv')
    // Simulate an out-of-band update to the stored row
    dbStore.rows.get(dbStore.key('app_1', 'hash_inv')).query = 'query V2'

    const found = await getPersistedQuery('app_1', 'hash_inv')
    expect(found?.query).toBe('query V2')
  })

  it('returns undefined for unknown hashes without caching the miss', async () => {
    expect(await getPersistedQuery('app_1', 'nope')).toBeUndefined()
    expect(await getPersistedQuery('app_1', 'nope')).toBeUndefined()
    // Misses are not cached — every lookup hits the DB
    expect(dbStore.findUnique).toHaveBeenCalledTimes(2)
  })

  it('registerPersistedQuery upserts — re-registering refreshes the row', async () => {
    await registerPersistedQuery('app_1', 'hash_up', 'query old')
    const updated = await registerPersistedQuery('app_1', 'hash_up', 'query new')

    expect(updated.query).toBe('query new')
    const found = await getPersistedQuery('app_1', 'hash_up')
    expect(found?.query).toBe('query new')
    expect(dbStore.rows.size).toBe(1)
  })
})
