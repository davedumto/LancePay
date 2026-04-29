import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSavedSearch = vi.hoisted(() => ({
  count: vi.fn(),
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  delete: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn().mockResolvedValue({ userId: 'privy-1' }),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn().mockResolvedValue({ id: 'user-1', privyId: 'privy-1' }),
    },
    invoice: { findMany: vi.fn().mockResolvedValue([]) },
    bankAccount: { findMany: vi.fn().mockResolvedValue([]) },
    contact: { findMany: vi.fn().mockResolvedValue([]) },
    tag: { findMany: vi.fn().mockResolvedValue([]) },
    savedSearch: mockSavedSearch,
  },
}))

import { GET as listSaved, POST as createSaved } from '../search/saved/route'
import { GET as getSaved, DELETE as deleteSaved } from '../search/saved/[id]/route'
import { POST as runSaved } from '../search/saved/[id]/run/route'
import { prisma } from '@/lib/db'

function req(method: string, url: string, body?: unknown) {
  return new Request(url, {
    method,
    headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }) as any
}

function idParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1', privyId: 'privy-1' } as any)
  mockSavedSearch.findMany.mockResolvedValue([])
  mockSavedSearch.findFirst.mockResolvedValue(null)
  mockSavedSearch.count.mockResolvedValue(0)
  mockSavedSearch.create.mockResolvedValue({
    id: 'sq-1',
    name: 'My Query',
    query: 'acme',
    filters: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  })
  mockSavedSearch.delete.mockResolvedValue({})
  vi.mocked(prisma.invoice.findMany).mockResolvedValue([])
  vi.mocked(prisma.bankAccount.findMany).mockResolvedValue([])
  vi.mocked(prisma.contact.findMany).mockResolvedValue([])
  vi.mocked(prisma.tag.findMany).mockResolvedValue([])
})

// ── GET /search/saved ──────────────────────────────────────────────────────────

describe('GET /search/saved', () => {
  it('returns empty list when no saved queries', async () => {
    const res = await listSaved(req('GET', 'http://localhost/api/routes-b/search/saved'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.savedQueries).toEqual([])
  })

  it('returns saved queries for the user', async () => {
    const entry = {
      id: 'sq-1',
      name: 'Invoice search',
      query: 'acme',
      filters: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    }
    mockSavedSearch.findMany.mockResolvedValueOnce([entry])
    const res = await listSaved(req('GET', 'http://localhost/api/routes-b/search/saved'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.savedQueries).toHaveLength(1)
    expect(body.savedQueries[0].name).toBe('Invoice search')
  })

  it('returns 401 when no token', async () => {
    const res = await listSaved(new Request('http://localhost/api/routes-b/search/saved') as any)
    expect(res.status).toBe(401)
  })
})

// ── POST /search/saved ─────────────────────────────────────────────────────────

describe('POST /search/saved', () => {
  it('creates a saved query and returns 201', async () => {
    const res = await createSaved(
      req('POST', 'http://localhost/api/routes-b/search/saved', { name: 'My Query', query: 'acme' }),
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.savedQuery).toHaveProperty('id', 'sq-1')
    expect(body.savedQuery).toHaveProperty('name', 'My Query')
  })

  it('returns 400 when name is missing', async () => {
    const res = await createSaved(
      req('POST', 'http://localhost/api/routes-b/search/saved', { query: 'acme' }),
    )
    expect(res.status).toBe(400)
  })

  it('returns 400 when query is missing', async () => {
    const res = await createSaved(
      req('POST', 'http://localhost/api/routes-b/search/saved', { name: 'My Query' }),
    )
    expect(res.status).toBe(400)
  })

  it('returns 400 when name is empty string', async () => {
    const res = await createSaved(
      req('POST', 'http://localhost/api/routes-b/search/saved', { name: '', query: 'acme' }),
    )
    expect(res.status).toBe(400)
  })

  it('returns 400 when name exceeds 100 chars', async () => {
    const res = await createSaved(
      req('POST', 'http://localhost/api/routes-b/search/saved', {
        name: 'x'.repeat(101),
        query: 'acme',
      }),
    )
    expect(res.status).toBe(400)
  })

  it('enforces cap of 50 saved queries', async () => {
    mockSavedSearch.count.mockResolvedValueOnce(50)
    const res = await createSaved(
      req('POST', 'http://localhost/api/routes-b/search/saved', { name: 'Extra', query: 'test' }),
    )
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toMatch(/50/)
  })

  it('allows creation when count is exactly 49', async () => {
    mockSavedSearch.count.mockResolvedValueOnce(49)
    const res = await createSaved(
      req('POST', 'http://localhost/api/routes-b/search/saved', {
        name: 'Query 50',
        query: 'test',
      }),
    )
    expect(res.status).toBe(201)
  })

  it('stores filters JSON when provided', async () => {
    const filters = { type: 'invoices' }
    mockSavedSearch.create.mockResolvedValueOnce({
      id: 'sq-2',
      name: 'Invoice only',
      query: 'acme',
      filters,
      createdAt: new Date(),
    })
    const res = await createSaved(
      req('POST', 'http://localhost/api/routes-b/search/saved', {
        name: 'Invoice only',
        query: 'acme',
        filters,
      }),
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.savedQuery.filters).toEqual(filters)
  })
})

// ── GET /search/saved/[id] ─────────────────────────────────────────────────────

describe('GET /search/saved/[id]', () => {
  it('returns the saved query by id', async () => {
    const entry = { id: 'sq-1', name: 'My Query', query: 'acme', filters: null, createdAt: new Date() }
    mockSavedSearch.findFirst.mockResolvedValueOnce(entry)
    const res = await getSaved(req('GET', 'http://localhost/api/routes-b/search/saved/sq-1'), idParams('sq-1'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.savedQuery.id).toBe('sq-1')
  })

  it('returns 404 for unknown id', async () => {
    const res = await getSaved(
      req('GET', 'http://localhost/api/routes-b/search/saved/nope'),
      idParams('nope'),
    )
    expect(res.status).toBe(404)
  })
})

// ── DELETE /search/saved/[id] ──────────────────────────────────────────────────

describe('DELETE /search/saved/[id]', () => {
  it('deletes and returns 204', async () => {
    mockSavedSearch.findFirst.mockResolvedValueOnce({ id: 'sq-1', userId: 'user-1' })
    const res = await deleteSaved(
      req('DELETE', 'http://localhost/api/routes-b/search/saved/sq-1'),
      idParams('sq-1'),
    )
    expect(res.status).toBe(204)
  })

  it('returns 404 for unknown id', async () => {
    const res = await deleteSaved(
      req('DELETE', 'http://localhost/api/routes-b/search/saved/nope'),
      idParams('nope'),
    )
    expect(res.status).toBe(404)
  })
})

// ── POST /search/saved/[id]/run ────────────────────────────────────────────────

describe('POST /search/saved/[id]/run', () => {
  it('returns results in search response shape', async () => {
    mockSavedSearch.findFirst.mockResolvedValueOnce({
      id: 'sq-1',
      userId: 'user-1',
      query: 'acme',
      filters: null,
    })
    const res = await runSaved(
      req('POST', 'http://localhost/api/routes-b/search/saved/sq-1/run'),
      idParams('sq-1'),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('query', 'acme')
    expect(body).toHaveProperty('savedSearchId', 'sq-1')
    expect(body.results).toHaveProperty('invoices')
    expect(body.results).toHaveProperty('bankAccounts')
    expect(body.results).toHaveProperty('contacts')
    expect(body.results).toHaveProperty('tags')
    expect(body.facets).toHaveProperty('types')
    expect(body.facets).toHaveProperty('statuses')
  })

  it('returns 404 for unknown saved search id', async () => {
    const res = await runSaved(
      req('POST', 'http://localhost/api/routes-b/search/saved/nope/run'),
      idParams('nope'),
    )
    expect(res.status).toBe(404)
  })

  it('respects type filter from saved filters', async () => {
    mockSavedSearch.findFirst.mockResolvedValueOnce({
      id: 'sq-2',
      userId: 'user-1',
      query: 'acme',
      filters: { type: 'invoices' },
    })
    const res = await runSaved(
      req('POST', 'http://localhost/api/routes-b/search/saved/sq-2/run'),
      idParams('sq-2'),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    // contacts, bankAccounts, tags should be empty arrays (filter = invoices only)
    expect(body.results.contacts).toEqual([])
    expect(body.results.bankAccounts).toEqual([])
    expect(body.results.tags).toEqual([])
  })

  it('base /search endpoint still works after a saved search is deleted', async () => {
    // Deleting a saved search must not affect the savedSearch.findMany that lists them
    mockSavedSearch.findFirst.mockResolvedValueOnce({ id: 'sq-1', userId: 'user-1' })
    await deleteSaved(
      req('DELETE', 'http://localhost/api/routes-b/search/saved/sq-1'),
      idParams('sq-1'),
    )
    // After deletion, listing returns empty (no saved searches remain)
    mockSavedSearch.findMany.mockResolvedValueOnce([])
    const listRes = await listSaved(req('GET', 'http://localhost/api/routes-b/search/saved'))
    expect(listRes.status).toBe(200)
    const body = await listRes.json()
    expect(body.savedQueries).toEqual([])
  })
})
