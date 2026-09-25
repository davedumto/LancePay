import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    savedFilter: { count: vi.fn(), findMany: vi.fn(), create: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { GET, POST } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const validDefinition = {
  match: 'all',
  conditions: [
    { field: 'status', operator: 'in', value: ['pending', 'overdue'] },
    { field: 'amount', operator: 'gte', value: 500 },
  ],
}

function makeRequest(
  method: 'GET' | 'POST',
  { body, headers = { authorization: 'Bearer token' }, query = '' }: { body?: string; headers?: Record<string, string>; query?: string } = {},
) {
  return new NextRequest(`http://localhost/api/saved-filters${query}`, { method, headers, body })
}

function postBody(body: unknown) {
  return makeRequest('POST', { body: JSON.stringify(body) })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' } as never)
  vi.mocked(prisma.savedFilter.count).mockResolvedValue(0)
  vi.mocked(prisma.savedFilter.findMany).mockResolvedValue([])
  vi.mocked(prisma.savedFilter.create).mockImplementation((async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'filter-1',
    name: data.name,
    entityType: data.entityType,
    filters: data.filters,
    isDefault: false,
    createdAt: new Date('2026-09-25T00:00:00Z'),
    updatedAt: new Date('2026-09-25T00:00:00Z'),
  })) as never)
})

describe('POST /api/saved-filters', () => {
  it('saves a validated definition as structured JSON scoped to the caller', async () => {
    const res = await POST(postBody({ name: '  Big unpaid  ', definition: validDefinition }))

    expect(res.status).toBe(201)
    expect(prisma.savedFilter.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        name: 'Big unpaid',
        entityType: 'invoice',
        filters: validDefinition,
      },
      select: expect.any(Object),
    })
    const body = await res.json()
    expect(body.savedFilter).toMatchObject({ id: 'filter-1', name: 'Big unpaid', filters: validDefinition })
    expect(body.savedFilter.userId).toBeUndefined()
  })

  it('stores the normalized definition, not the raw request payload', async () => {
    await POST(postBody({ name: 'Paid', definition: { conditions: [{ field: 'status', operator: 'eq', value: 'paid' }] } }))

    expect(vi.mocked(prisma.savedFilter.create).mock.calls[0][0].data.filters).toEqual({
      match: 'all',
      conditions: [{ field: 'status', operator: 'eq', value: 'paid' }],
    })
  })

  it('returns 401 without a bearer token', async () => {
    const res = await POST(makeRequest('POST', { headers: {}, body: JSON.stringify({ name: 'x', definition: validDefinition }) }))
    expect(res.status).toBe(401)
    expect(prisma.savedFilter.create).not.toHaveBeenCalled()
  })

  it('returns 401 for an invalid token', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await POST(postBody({ name: 'x', definition: validDefinition }))
    expect(res.status).toBe(401)
  })

  it('rejects malformed JSON', async () => {
    const res = await POST(makeRequest('POST', { body: '{"name":' }))
    expect(res.status).toBe(400)
  })

  it('rejects a missing or blank name', async () => {
    expect((await POST(postBody({ definition: validDefinition }))).status).toBe(400)
    expect((await POST(postBody({ name: '   ', definition: validDefinition }))).status).toBe(400)
    expect((await POST(postBody({ name: 'x'.repeat(101), definition: validDefinition }))).status).toBe(400)
  })

  it('rejects client-supplied ownership and unexpected top-level fields', async () => {
    const res = await POST(postBody({ name: 'x', definition: validDefinition, userId: 'user-2' }))
    expect(res.status).toBe(400)
    expect(prisma.savedFilter.create).not.toHaveBeenCalled()
  })

  it('rejects an unknown field', async () => {
    const res = await POST(postBody({ name: 'x', definition: { conditions: [{ field: 'userId', operator: 'eq', value: 'user-2' }] } }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Invalid filter definition')
    expect(body.details[0]).toMatch(/not a filterable invoice field/)
    expect(prisma.savedFilter.create).not.toHaveBeenCalled()
  })

  it('rejects an unknown operator', async () => {
    const res = await POST(postBody({ name: 'x', definition: { conditions: [{ field: 'status', operator: 'regex', value: '.*' }] } }))
    expect(res.status).toBe(400)
    expect((await res.json()).details[0]).toMatch(/not a supported operator/)
  })

  it('rejects a malformed definition', async () => {
    expect((await POST(postBody({ name: 'x', definition: { conditions: [] } }))).status).toBe(400)
    expect((await POST(postBody({ name: 'x', definition: [{ field: 'status' }] }))).status).toBe(400)
    expect((await POST(postBody({ name: 'x' }))).status).toBe(400)
  })

  it('rejects an invalid value type for the field', async () => {
    const res = await POST(postBody({ name: 'x', definition: { conditions: [{ field: 'amount', operator: 'gt', value: '100' }] } }))
    expect(res.status).toBe(400)
  })

  it('rejects raw query strings and nested Prisma expressions', async () => {
    const attempts = [
      'SELECT * FROM "Invoice"',
      { where: { userId: 'user-2' } },
      { conditions: [{ field: 'status', operator: 'eq', value: { not: 'paid' } }] },
      { conditions: [{ field: 'status', operator: 'eq', value: 'paid' }], OR: [{ userId: 'user-2' }] },
      { conditions: [{ field: '__proto__', operator: 'eq', value: 'x' }] },
    ]
    for (const definition of attempts) {
      const res = await POST(postBody({ name: 'x', definition }))
      expect(res.status).toBe(400)
    }
    expect(prisma.savedFilter.create).not.toHaveBeenCalled()
  })

  it('returns 409 when the caller already has a filter with the same name', async () => {
    vi.mocked(prisma.savedFilter.create).mockRejectedValue(
      Object.assign(new Error('Unique constraint failed on the fields: (`userId`,`name`)'), { code: 'P2002' }),
    )
    const res = await POST(postBody({ name: 'Big unpaid', definition: validDefinition }))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('You already have a saved filter with this name')
  })

  it('lets different users save filters with the same name', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: 'user-1' } as never)
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: 'user-2' } as never)

    expect((await POST(postBody({ name: 'Mine', definition: validDefinition }))).status).toBe(201)
    expect((await POST(postBody({ name: 'Mine', definition: validDefinition }))).status).toBe(201)

    const owners = vi.mocked(prisma.savedFilter.create).mock.calls.map(([args]) => args.data.userId)
    expect(owners).toEqual(['user-1', 'user-2'])
  })

  it('returns a generic 500 on unexpected errors', async () => {
    vi.mocked(prisma.savedFilter.create).mockRejectedValue(new Error('relation "SavedFilter" does not exist'))
    const res = await POST(postBody({ name: 'x', definition: validDefinition }))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('relation')
  })
})

describe('GET /api/saved-filters', () => {
  it('returns 401 without a bearer token', async () => {
    const res = await GET(makeRequest('GET', { headers: {} }))
    expect(res.status).toBe(401)
    expect(prisma.savedFilter.findMany).not.toHaveBeenCalled()
  })

  it('lists only the caller\'s invoice filters with pagination', async () => {
    vi.mocked(prisma.savedFilter.count).mockResolvedValue(3)
    vi.mocked(prisma.savedFilter.findMany).mockResolvedValue([{ id: 'filter-1', name: 'A' }] as never)

    const res = await GET(makeRequest('GET', { query: '?page=2&pageSize=2' }))

    expect(res.status).toBe(200)
    const where = { userId: 'user-1', entityType: 'invoice' }
    expect(prisma.savedFilter.count).toHaveBeenCalledWith({ where })
    expect(prisma.savedFilter.findMany).toHaveBeenCalledWith({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: 2,
      take: 2,
      select: expect.not.objectContaining({ userId: true }),
    })
    expect(await res.json()).toEqual({
      savedFilters: [{ id: 'filter-1', name: 'A' }],
      pagination: { page: 2, pageSize: 2, totalRows: 3, totalPages: 2 },
    })
  })

  it('clamps page size to the maximum and ignores a client-supplied userId', async () => {
    await GET(makeRequest('GET', { query: '?pageSize=100000&userId=user-2' }))

    expect(prisma.savedFilter.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1', entityType: 'invoice' }, take: 100, skip: 0 }),
    )
  })
})
