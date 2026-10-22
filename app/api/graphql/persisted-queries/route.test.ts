import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { POST, computeSha256, normalizeQuery } from './route'
import { prisma } from '@/lib/db'

vi.mock('@/lib/db', () => ({
  prisma: {
    persistedQuery: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  },
}))

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}))

describe('POST /api/graphql/persisted-queries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function makeRequest(body: unknown, headers: Record<string, string> = {}) {
    return new NextRequest('http://localhost:3000/api/graphql/persisted-queries', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  }

  it('registers a valid persisted query with computed sha256 hash', async () => {
    const query = `
      # Fetch active user invoices
      query GetUserInvoices {
        user {
          id
          invoices {
            id
            amount
          }
        }
      }
    `
    const normalized = normalizeQuery(query)
    const expectedHash = computeSha256(normalized)

    vi.mocked(prisma.persistedQuery.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.persistedQuery.create).mockResolvedValue({
      id: 'pq_123',
      appId: 'app_abc',
      hash: expectedHash,
      query,
      normalized,
      depth: 3,
      complexity: 5,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const req = makeRequest({ appId: 'app_abc', query })
    const res = await POST(req)
    const json = await res.json()

    expect(res.status).toBe(201)
    expect(json.alreadyRegistered).toBe(false)
    expect(json.persistedQuery.hash).toBe(expectedHash)
    expect(prisma.persistedQuery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        appId: 'app_abc',
        hash: expectedHash,
        normalized,
      }),
    })
  })

  it('accepts caller-provided hash when it matches computed hash', async () => {
    const query = 'query { ping }'
    const normalized = normalizeQuery(query)
    const correctHash = computeSha256(normalized)

    vi.mocked(prisma.persistedQuery.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.persistedQuery.create).mockResolvedValue({
      id: 'pq_124',
      appId: 'app_abc',
      hash: correctHash,
      query,
      normalized,
      depth: 1,
      complexity: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const req = makeRequest({ appId: 'app_abc', query, hash: correctHash })
    const res = await POST(req)
    expect(res.status).toBe(201)
  })

  it('rejects caller-provided hash mismatch with 400 and HASH_MISMATCH', async () => {
    const query = 'query { ping }'
    const wrongHash = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

    const req = makeRequest({ appId: 'app_abc', query, hash: wrongHash })
    const res = await POST(req)
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.code).toBe('HASH_MISMATCH')
    expect(prisma.persistedQuery.create).not.toHaveBeenCalled()
  })

  it('rejects queries exceeding caller tier max depth', async () => {
    // 6 levels deep exceeding default free tier maxDepth of 5
    const deepQuery = `
      query DeepQuery {
        a {
          b {
            c {
              d {
                e {
                  f
                }
              }
            }
          }
        }
      }
    `

    const req = makeRequest({ appId: 'app_abc', query: deepQuery, tier: 'free' })
    const res = await POST(req)
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.code).toBe('GATEWAY_DEPTH_EXCEEDED')
    expect(json.depth).toBeGreaterThan(5)
    expect(prisma.persistedQuery.create).not.toHaveBeenCalled()
  })

  it('allows deeper queries for elevated tier such as enterprise', async () => {
    const deepQuery = `
      query DeepQuery {
        a {
          b {
            c {
              d {
                e {
                  f
                }
              }
            }
          }
        }
      }
    `
    const normalized = normalizeQuery(deepQuery)
    const hash = computeSha256(normalized)

    vi.mocked(prisma.persistedQuery.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.persistedQuery.create).mockResolvedValue({
      id: 'pq_125',
      appId: 'app_abc',
      hash,
      query: deepQuery,
      normalized,
      depth: 6,
      complexity: 6,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const req = makeRequest({ appId: 'app_abc', query: deepQuery, tier: 'enterprise' })
    const res = await POST(req)
    expect(res.status).toBe(201)
  })

  it('rejects queries exceeding caller tier max complexity', async () => {
    // Generate query with > 55 fields exceeding free tier limit of 50
    const fields = Array.from({ length: 60 }, (_, i) => `field_${i}`).join(' ')
    const complexQuery = `query Complex { user { ${fields} } }`

    const req = makeRequest({ appId: 'app_abc', query: complexQuery, tier: 'free' })
    const res = await POST(req)
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.code).toBe('GATEWAY_COMPLEXITY_EXCEEDED')
    expect(prisma.persistedQuery.create).not.toHaveBeenCalled()
  })

  it('stores registration keyed by developer app plus hash so different apps are distinct', async () => {
    const query = 'query SharedQuery { items { id name } }'
    const normalized = normalizeQuery(query)
    const hash = computeSha256(normalized)

    vi.mocked(prisma.persistedQuery.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.persistedQuery.create).mockResolvedValue({
      id: 'pq_app2',
      appId: 'app_xyz',
      hash,
      query,
      normalized,
      depth: 2,
      complexity: 3,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const req = makeRequest({ appId: 'app_xyz', query })
    const res = await POST(req)
    expect(res.status).toBe(201)

    expect(prisma.persistedQuery.findUnique).toHaveBeenCalledWith({
      where: {
        appId_hash: {
          appId: 'app_xyz',
          hash,
        },
      },
    })
  })

  it('returns existing entry when already registered under same appId', async () => {
    const query = 'query { me { id } }'
    const normalized = normalizeQuery(query)
    const hash = computeSha256(normalized)

    vi.mocked(prisma.persistedQuery.findUnique).mockResolvedValue({
      id: 'pq_existing',
      appId: 'app_abc',
      hash,
      query,
      normalized,
      depth: 2,
      complexity: 2,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const req = makeRequest({ appId: 'app_abc', query })
    const res = await POST(req)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.alreadyRegistered).toBe(true)
    expect(json.persistedQuery.id).toBe('pq_existing')
    expect(prisma.persistedQuery.create).not.toHaveBeenCalled()
  })

  it('rejects invalid request body with 400', async () => {
    const req = makeRequest({ appId: '' })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('rejects malformed JSON with 400', async () => {
    const req = makeRequest('not-json')
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('returns 500 when database throws', async () => {
    vi.mocked(prisma.persistedQuery.findUnique).mockRejectedValue(new Error('DB failure'))

    const req = makeRequest({ appId: 'app_abc', query: 'query { test }' })
    const res = await POST(req)
    expect(res.status).toBe(500)
  })
})
