import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const serviceFindMany = vi.fn()
const serviceCount = vi.fn()
const serviceCreate = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    serviceCatalogItem: { findMany: serviceFindMany, count: serviceCount, create: serviceCreate },
  },
}))

const BASE_URL = 'http://localhost/api/routes-b/services'

function makeGet(params: Record<string, string> = {}) {
  const url = new URL(BASE_URL)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return new NextRequest(url.toString(), { headers: { authorization: 'Bearer token' } })
}

function makePost(body: unknown) {
  return new NextRequest(BASE_URL, {
    method: 'POST',
    headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const mockUser = { id: 'user_1' }
const mockItem = { id: 'svc_1', name: 'Logo Design', description: null, rateUsdc: '200', currency: 'USD', unit: 'project', isActive: true, createdAt: new Date(), updatedAt: new Date() }

describe('GET /api/routes-b/services', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.resetModules() })

  it('returns 401 when unauthenticated', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-b/services/route')
    const res = await GET(makeGet())
    expect(res.status).toBe(401)
  })

  it('returns paginated service items', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(mockUser)
    serviceFindMany.mockResolvedValue([mockItem])
    serviceCount.mockResolvedValue(1)

    const { GET } = await import('@/app/api/routes-b/services/route')
    const res = await GET(makeGet())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.items).toHaveLength(1)
    expect(json.pagination.totalCount).toBe(1)
  })
})

describe('POST /api/routes-b/services', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.resetModules() })

  it('returns 401 when unauthenticated', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-b/services/route')
    const res = await POST(makePost({ name: 'Test', rateUsdc: 100 }))
    expect(res.status).toBe(401)
  })

  it('returns 400 when name is missing', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(mockUser)
    const { POST } = await import('@/app/api/routes-b/services/route')
    const res = await POST(makePost({ rateUsdc: 100 }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/name/i)
  })

  it('returns 400 when rateUsdc is invalid', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(mockUser)
    const { POST } = await import('@/app/api/routes-b/services/route')
    const res = await POST(makePost({ name: 'Design', rateUsdc: -1 }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/rateUsdc/i)
  })

  it('creates a service catalog item successfully', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(mockUser)
    serviceCreate.mockResolvedValue(mockItem)

    const { POST } = await import('@/app/api/routes-b/services/route')
    const res = await POST(makePost({ name: 'Logo Design', rateUsdc: 200, unit: 'project' }))
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.name).toBe('Logo Design')
  })

  it('returns 400 for invalid JSON body', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(mockUser)
    const { POST } = await import('@/app/api/routes-b/services/route')
    const req = new NextRequest(BASE_URL, {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: 'not-json',
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })
})
