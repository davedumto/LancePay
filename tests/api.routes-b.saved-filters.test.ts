import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const savedFilterFindMany = vi.fn()
const savedFilterCreate = vi.fn()
const savedFilterFindUnique = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    savedFilter: {
      findMany: savedFilterFindMany,
      create: savedFilterCreate,
      findUnique: savedFilterFindUnique,
    },
  },
}))

const BASE_URL = 'http://localhost/api/routes-b/saved-filters'

function makeRequest(
  headers: Record<string, string> = { authorization: 'Bearer token' },
  body?: any,
) {
  return new NextRequest(BASE_URL, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
}

describe('GET /api/routes-b/saved-filters (#936)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when no auth token is provided', async () => {
    const { GET } = await import('@/app/api/routes-b/saved-filters/route')
    const response = await GET(makeRequest({}))

    expect(response.status).toBe(401)
    expect(userFindUnique).not.toHaveBeenCalled()
  })

  it('returns 404 when the user is not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(null)

    const { GET } = await import('@/app/api/routes-b/saved-filters/route')
    const response = await GET(makeRequest())

    expect(response.status).toBe(404)
  })

  it('returns empty filters array when user has no filters', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    savedFilterFindMany.mockResolvedValue([])

    const { GET } = await import('@/app/api/routes-b/saved-filters/route')
    const response = await GET(makeRequest())

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.filters).toEqual([])
  })

  it('returns all filters for the user when no entityType query param', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    savedFilterFindMany.mockResolvedValue([
      {
        id: 'filter_1',
        name: 'Unpaid Invoices',
        entityType: 'invoice',
        filters: { status: 'pending' },
        isDefault: true,
        createdAt: new Date('2026-06-20T00:00:00Z'),
        updatedAt: new Date('2026-06-20T00:00:00Z'),
      },
    ])

    const { GET } = await import('@/app/api/routes-b/saved-filters/route')
    const response = await GET(makeRequest())

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.filters).toHaveLength(1)
    expect(savedFilterFindMany).toHaveBeenCalledWith({
      where: { userId: 'user_1' },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        entityType: true,
        filters: true,
        isDefault: true,
        createdAt: true,
        updatedAt: true,
      },
    })
  })

  it('filters by entityType when query param is provided', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    savedFilterFindMany.mockResolvedValue([])

    const { GET } = await import('@/app/api/routes-b/saved-filters/route')
    const url = new URL(BASE_URL)
    url.searchParams.set('entityType', 'invoice')
    const request = new NextRequest(url.toString(), { headers: { authorization: 'Bearer token' } })
    const response = await GET(request)

    expect(response.status).toBe(200)
    expect(savedFilterFindMany).toHaveBeenCalledWith({
      where: { userId: 'user_1', entityType: 'invoice' },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        entityType: true,
        filters: true,
        isDefault: true,
        createdAt: true,
        updatedAt: true,
      },
    })
  })
})

describe('POST /api/routes-b/saved-filters (#936)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when no auth token is provided', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-b/saved-filters/route')
    const response = await POST(
      makeRequest({}, { name: 'Test', entityType: 'invoice', filters: {} }),
    )

    expect(response.status).toBe(401)
  })

  it('returns 400 when name is missing', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })

    const { POST } = await import('@/app/api/routes-b/saved-filters/route')
    const response = await POST(makeRequest({}, { entityType: 'invoice', filters: {} }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'name, entityType, and filters are required',
    })
  })

  it('returns 400 when entityType is missing', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })

    const { POST } = await import('@/app/api/routes-b/saved-filters/route')
    const response = await POST(makeRequest({}, { name: 'Test', filters: {} }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'name, entityType, and filters are required',
    })
  })

  it('returns 400 when filters is missing', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })

    const { POST } = await import('@/app/api/routes-b/saved-filters/route')
    const response = await POST(makeRequest({}, { name: 'Test', entityType: 'invoice' }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'name, entityType, and filters are required',
    })
  })

  it('returns 400 when filters is not an object', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })

    const { POST } = await import('@/app/api/routes-b/saved-filters/route')
    const response = await POST(makeRequest({}, { name: 'Test', entityType: 'invoice', filters: 'invalid' }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'filters must be a valid JSON object' })
  })

  it('returns 409 when a filter with the same name already exists', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    savedFilterFindUnique.mockResolvedValue({ id: 'filter_1', userId: 'user_1', name: 'Test' })

    const { POST } = await import('@/app/api/routes-b/saved-filters/route')
    const response = await POST(
      makeRequest({}, { name: 'Test', entityType: 'invoice', filters: { status: 'pending' } }),
    )

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ error: 'A filter with this name already exists' })
  })

  it('creates a filter with valid data', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    savedFilterFindUnique.mockResolvedValue(null)
    savedFilterCreate.mockResolvedValue({
      id: 'filter_1',
      userId: 'user_1',
      name: 'Unpaid Invoices',
      entityType: 'invoice',
      filters: { status: 'pending', amount: { gt: 100 } },
      isDefault: false,
      createdAt: new Date('2026-06-23T00:00:00Z'),
      updatedAt: new Date('2026-06-23T00:00:00Z'),
    })

    const { POST } = await import('@/app/api/routes-b/saved-filters/route')
    const response = await POST(
      makeRequest({}, {
        name: 'Unpaid Invoices',
        entityType: 'invoice',
        filters: { status: 'pending', amount: { gt: 100 } },
        isDefault: true,
      }),
    )

    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.name).toBe('Unpaid Invoices')
    expect(savedFilterCreate).toHaveBeenCalledWith({
      data: {
        userId: 'user_1',
        name: 'Unpaid Invoices',
        entityType: 'invoice',
        filters: { status: 'pending', amount: { gt: 100 } },
        isDefault: true,
      },
    })
  })
})
