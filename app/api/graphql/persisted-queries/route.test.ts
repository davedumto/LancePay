import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    apiKey: { findFirst: vi.fn() },
    persistedGraphqlQuery: {
      upsert: vi.fn(),
    },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}))

import {
  POST,
  clearPersistedQueryRegistry,
  getPersistedQueryRegistrySize,
  normalizeGraphqlQuery,
  computeNormalizedQueryHash,
} from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const actor = { id: 'user-1', email: 'dev@lancepay.io' }
const NOW = new Date('2026-10-17T12:00:00.000Z')

function makeRequest(body?: unknown): NextRequest {
  return new NextRequest('http://localhost/api/graphql/persisted-queries', {
    method: 'POST',
    headers: { authorization: 'Bearer valid-token' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

describe('POST /api/graphql/persisted-queries (#1566)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearPersistedQueryRegistry()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)

    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue(actor as any)
    vi.mocked(prisma.apiKey.findFirst).mockImplementation(
      (async (args: any) => ({
        id: args.where.id,
        userId: 'user-1',
        isActive: true,
        deactivatesAt: null,
        tier: 'free',
      })) as any
    )
    vi.mocked((prisma as any).persistedGraphqlQuery.upsert).mockResolvedValue({} as any)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('normalizes the GraphQL query, computes its SHA-256 hash, and registers it keyed by (developerAppId, hash)', async () => {
    const rawQuery = `
      # Fetch invoices for dashboard
      query GetInvoices {
        invoices {
          id
          amount
        }
      }
    `
    const normalized = normalizeGraphqlQuery(rawQuery)
    const expectedHash = computeNormalizedQueryHash(normalized)

    const res = await POST(
      makeRequest({
        developerAppId: 'app-1',
        query: rawQuery,
        hash: expectedHash,
        operationName: 'GetInvoices',
      })
    )

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.created).toBe(true)
    expect(body.persistedQuery.hash).toBe(expectedHash)
    expect(body.persistedQuery.developerAppId).toBe('app-1')
    expect(body.persistedQuery.normalizedQuery).toBe('query GetInvoices{invoices{id amount}}')
    expect(body.persistedQuery.depth).toBe(2)
  })

  it('rejects caller hash mismatches against the normalized query SHA-256 with 422 QUERY_HASH_MISMATCH', async () => {
    const wrongHash = 'f'.repeat(64)
    const res = await POST(
      makeRequest({
        developerAppId: 'app-1',
        query: 'query { invoices { id } }',
        hash: wrongHash,
      })
    )

    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.code).toBe('QUERY_HASH_MISMATCH')
    expect(body.details.providedHash).toBe(wrongHash)
    expect(body.details.computedHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects queries whose depth or complexity exceeds the gateway thresholds for the caller tier', async () => {
    // Free tier maxDepth is 5; this query has depth 7
    const overlyDeepQuery =
      'query Deep { a { b { c { d { e { f { id } } } } } } }'

    const deepRes = await POST(
      makeRequest({
        developerAppId: 'app-1',
        query: overlyDeepQuery,
      })
    )

    expect(deepRes.status).toBe(422)
    const deepBody = await deepRes.json()
    expect(deepBody.code).toBe('QUERY_DEPTH_EXCEEDED')
    expect(deepBody.details.depth).toBe(7)
    expect(deepBody.details.maxDepth).toBe(5)

    // Free tier maxComplexity is 30; wide selection of 35 fields at depth 2 exceeds it
    const manyFields = Array.from({ length: 35 }, (_, i) => `field_${i}`).join(' ')
    const overlyComplexQuery = `query Wide { invoices { ${manyFields} } }`

    const complexRes = await POST(
      makeRequest({
        developerAppId: 'app-1',
        query: overlyComplexQuery,
      })
    )

    expect(complexRes.status).toBe(422)
    const complexBody = await complexRes.json()
    expect(complexBody.code).toBe('QUERY_COMPLEXITY_EXCEEDED')
  })

  it('stores the same query text under different developerAppIds as distinct entries', async () => {
    const query = 'query Shared { invoices { id status } }'

    const resApp1 = await POST(
      makeRequest({ developerAppId: 'app-alpha', query })
    )
    const resApp2 = await POST(
      makeRequest({ developerAppId: 'app-beta', query })
    )

    expect(resApp1.status).toBe(201)
    expect(resApp2.status).toBe(201)

    const body1 = await resApp1.json()
    const body2 = await resApp2.json()

    expect(body1.persistedQuery.hash).toBe(body2.persistedQuery.hash)
    expect(body1.persistedQuery.id).not.toBe(body2.persistedQuery.id)
    expect(body1.persistedQuery.developerAppId).toBe('app-alpha')
    expect(body2.persistedQuery.developerAppId).toBe('app-beta')
    expect(getPersistedQueryRegistrySize()).toBe(2)
  })
})
