import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  computePersistedQueryHash,
  getPersistedQuery,
  normalizePersistedQuery,
  PersistedQueryConflictError,
  PersistedQueryHashMismatchError,
  pruneStalePersistedQueries,
  PERSISTED_QUERY_STORE,
  registerPersistedQuery,
  resetPersistedQueryStore,
} from '@/lib/persisted-queries'

const QUERY = 'query GetUser {\n  # fetch user\n  user { id name }\n}'

describe('persisted query hashing (#1885)', () => {
  beforeEach(() => {
    resetPersistedQueryStore()
  })

  it('normalizes comments and whitespace before hashing', () => {
    expect(normalizePersistedQuery(QUERY)).toBe('query GetUser { user { id name } }')
    // Formatting differences that normalize away produce the same hash
    const reformatted = 'query   GetUser { user { id name } }'
    expect(computePersistedQueryHash(reformatted)).toBe(
      computePersistedQueryHash(QUERY),
    )
  })

  it('registers successfully when the hash matches the normalized query', () => {
    const hash = computePersistedQueryHash(QUERY)
    const record = registerPersistedQuery('app_1', hash, QUERY)
    expect(record.hash).toBe(hash)
    expect(record.query).toBe(QUERY)
    expect(getPersistedQuery('app_1', hash)?.query).toBe(QUERY)
  })

  it('rejects a hash that is not the SHA-256 of the query text', () => {
    expect(() =>
      registerPersistedQuery('app_1', 'deadbeef'.repeat(8), QUERY),
    ).toThrow(PersistedQueryHashMismatchError)
    try {
      registerPersistedQuery('app_1', 'bad', QUERY)
    } catch (error) {
      expect((error as PersistedQueryHashMismatchError).code).toBe('HASH_MISMATCH')
      expect((error as PersistedQueryHashMismatchError).computedHash).toBe(
        computePersistedQueryHash(QUERY),
      )
    }
  })

  it('rejects re-registration of the same hash with different query text', () => {
    const hash = computePersistedQueryHash(QUERY)
    registerPersistedQuery('app_1', hash, QUERY)

    // Identical raw text is idempotent
    const again = registerPersistedQuery('app_1', hash, QUERY)
    expect(again.query).toBe(QUERY)

    // Different raw text that normalizes to the same query shares the
    // hash but conflicts on the stored text
    const sameNormalized = 'query GetUser { user { id name } }'
    expect(computePersistedQueryHash(sameNormalized)).toBe(hash)
    expect(() => registerPersistedQuery('app_1', hash, sameNormalized)).toThrow(
      PersistedQueryConflictError,
    )
  })
})

describe('persisted query access metrics (#1886)', () => {
  beforeEach(() => {
    resetPersistedQueryStore()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('increments accessCount and refreshes lastAccessedAt on every lookup', () => {
    const hash = computePersistedQueryHash(QUERY)
    registerPersistedQuery('app_1', hash, QUERY)

    vi.advanceTimersByTime(1000)
    getPersistedQuery('app_1', hash)
    vi.advanceTimersByTime(1000)
    const record = getPersistedQuery('app_1', hash)

    expect(record?.accessCount).toBe(2)
    expect(record?.lastAccessedAt.getTime()).toBe(Date.now())
  })

  it('does not count lookups for missing or wrong-app hashes', () => {
    const hash = computePersistedQueryHash(QUERY)
    registerPersistedQuery('app_1', hash, QUERY)

    expect(getPersistedQuery('app_2', hash)).toBeUndefined()
    expect(getPersistedQuery('app_1', 'unknown')).toBeUndefined()
    expect(getPersistedQuery('app_1', hash)?.accessCount).toBe(1)
  })

  it('prunes records not accessed within the configured window', () => {
    const hashA = computePersistedQueryHash('query A { a }')
    const hashB = computePersistedQueryHash('query B { b }')
    registerPersistedQuery('app_1', hashA, 'query A { a }')
    registerPersistedQuery('app_1', hashB, 'query B { b }')

    // Touch B so it stays fresh; let A go stale
    vi.advanceTimersByTime(40 * 24 * 60 * 60 * 1000) // 40 days
    getPersistedQuery('app_1', hashB)

    const pruned = pruneStalePersistedQueries(30 * 24 * 60 * 60 * 1000)
    expect(pruned).toBe(1)
    expect(getPersistedQueryRaw('app_1', hashA)).toBeUndefined()
    expect(getPersistedQuery('app_1', hashB)).toBeDefined()
  })
})

// Access-count-free peek for asserting store contents without mutating metrics.
function getPersistedQueryRaw(appId: string, hash: string) {
  return PERSISTED_QUERY_STORE.get(`${appId}:${hash}`)
}
