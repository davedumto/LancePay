import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    apiKey: { findFirst: vi.fn() },
    sandboxSession: { findFirst: vi.fn() },
    persistedGraphqlQuery: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}))

import {
  GET,
  clearPersistedQueryStore,
  seedPersistedQueryForTest,
  INDISTINGUISHABLE_404_BODY,
} from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const actor = { id: 'user-1', email: 'dev@lancepay.io' }
const NOW = new Date('2026-10-17T12:00:00.000Z')
const SAMPLE_HASH = 'a'.repeat(64)

function makeRequest(
  hash = SAMPLE_HASH,
  query = 'developerAppId=app-1',
  headers: Record<string, string> = {}
): NextRequest {
  const suffix = query ? `?${query}` : ''
  return new NextRequest(
    `http://localhost/api/graphql/persisted-queries/${hash}${suffix}`,
    {
      method: 'GET',
      headers: {
        authorization: 'Bearer valid-token',
        ...headers,
      },
    }
  )
}

describe('GET /api/graphql/persisted-queries/[hash] (#1567)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearPersistedQueryStore()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)

    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue(actor as any)
    vi.mocked(prisma.apiKey.findFirst).mockResolvedValue({
      id: 'app-1',
      userId: 'user-1',
      isActive: true,
      deactivatesAt: null,
      keyHint: 'lp_live_1234',
    } as any)
    vi.mocked(prisma.sandboxSession.findFirst).mockResolvedValue(null)
    vi.mocked((prisma as any).persistedGraphqlQuery.findFirst).mockResolvedValue(null)
    vi.mocked((prisma as any).persistedGraphqlQuery.update).mockResolvedValue({} as any)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves a persisted GraphQL query scoped to the caller developerAppId and increments accessCount', async () => {
    seedPersistedQueryForTest({
      id: 'pq-1',
      developerAppId: 'app-1',
      hash: SAMPLE_HASH,
      query: 'query GetInvoices { invoices { id amount } }',
      operationName: 'GetInvoices',
      depth: 2,
      complexity: 4,
      accessCount: 10,
      lastAccessedAt: null,
      createdAt: NOW,
    })

    const res = await GET(makeRequest(), { params: { hash: SAMPLE_HASH } })
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.persistedQuery.hash).toBe(SAMPLE_HASH)
    expect(body.persistedQuery.developerAppId).toBe('app-1')
    expect(body.persistedQuery.accessCount).toBe(11)
    expect(body.persistedQuery.lastAccessedAt).toBe(NOW.toISOString())
    expect((prisma as any).persistedGraphqlQuery.update).toHaveBeenCalledWith({
      where: { id: 'pq-1' },
      data: {
        accessCount: { increment: 1 },
        lastAccessedAt: NOW,
      },
    })
  })

  it('returns an indistinguishable 404 between a hash that is not-registered and one that belongs to another developer app', async () => {
    // Register SAMPLE_HASH under app-other, NOT app-1
    seedPersistedQueryForTest({
      id: 'pq-other',
      developerAppId: 'app-other',
      hash: SAMPLE_HASH,
      query: 'query Secret { viewer { id } }',
      operationName: 'Secret',
      depth: 2,
      complexity: 2,
      accessCount: 0,
      lastAccessedAt: null,
      createdAt: NOW,
    })

    const unregisteredHash = 'b'.repeat(64)

    // 1. Querying unregistered hash under caller's own app-1
    const notRegisteredRes = await GET(
      makeRequest(unregisteredHash, 'developerAppId=app-1'),
      { params: { hash: unregisteredHash } }
    )

    // 2. Querying SAMPLE_HASH (registered to app-other) under caller's app-1
    const wrongAppScopeRes = await GET(
      makeRequest(SAMPLE_HASH, 'developerAppId=app-1'),
      { params: { hash: SAMPLE_HASH } }
    )

    // 3. Querying SAMPLE_HASH by passing developerAppId=app-other (which caller does not own)
    vi.mocked(prisma.apiKey.findFirst).mockResolvedValueOnce(null)
    const unauthorizedAppRes = await GET(
      makeRequest(SAMPLE_HASH, 'developerAppId=app-other'),
      { params: { hash: SAMPLE_HASH } }
    )

    expect(notRegisteredRes.status).toBe(404)
    expect(wrongAppScopeRes.status).toBe(404)
    expect(unauthorizedAppRes.status).toBe(404)

    const body1 = await notRegisteredRes.json()
    const body2 = await wrongAppScopeRes.json()
    const body3 = await unauthorizedAppRes.json()

    expect(body1).toEqual(INDISTINGUISHABLE_404_BODY)
    expect(body2).toEqual(INDISTINGUISHABLE_404_BODY)
    expect(body3).toEqual(INDISTINGUISHABLE_404_BODY)
  })

  it('rejects lookups when the parent developer app is disabled or past deactivatesAt (403 DEVELOPER_APP_DISABLED)', async () => {
    vi.mocked(prisma.apiKey.findFirst).mockResolvedValueOnce({
      id: 'app-1',
      userId: 'user-1',
      isActive: false,
      deactivatesAt: null,
    } as any)

    const res = await GET(makeRequest(), { params: { hash: SAMPLE_HASH } })
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('DEVELOPER_APP_DISABLED')
  })

  it('rejects lookups when the parent developer app is in sandbox mode mismatching the live gateway mode (403 GATEWAY_MODE_MISMATCH)', async () => {
    // Active sandbox session makes the app in sandbox mode while gateway defaults to live
    vi.mocked(prisma.sandboxSession.findFirst).mockResolvedValueOnce({
      id: 'sbx-active-1',
    } as any)

    const res = await GET(
      makeRequest(SAMPLE_HASH, 'developerAppId=app-1', { 'x-gateway-mode': 'live' }),
      { params: { hash: SAMPLE_HASH } }
    )

    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('GATEWAY_MODE_MISMATCH')
    expect(body.details).toEqual({ appMode: 'sandbox', gatewayMode: 'live' })
  })

  it('returns 400 for malformed SHA-256 hash', async () => {
    const res = await GET(makeRequest('not-a-sha256'), {
      params: { hash: 'not-a-sha256' },
    })
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('INVALID_QUERY_HASH')
  })
})
