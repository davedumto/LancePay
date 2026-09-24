import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET, POST } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    product: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    productPriceVersion: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUser = { id: 'user-1', privyId: 'privy-1' }
const mockClaims = { userId: 'privy-1' }

function makeRequest(method: string = 'GET', body?: any): NextRequest {
  return new NextRequest('http://localhost/api/products', {
    method,
    headers: { authorization: 'Bearer token' },
    body: body ? JSON.stringify(body) : undefined,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
  // Run the transaction callback against the mocked prisma delegate.
  vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(prisma))
})

describe('GET /api/products', () => {
  it('returns products with their active price version flattened', async () => {
    vi.mocked(prisma.product.findMany).mockResolvedValue([
      {
        id: 'prod-1',
        userId: 'user-1',
        name: 'Widget',
        priceUsdc: '10.000000',
        priceVersions: [{ id: 'pv-1', priceUsdc: '10.000000', isActive: true }],
      },
    ] as any)

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.products).toHaveLength(1)
    expect(data.products[0].activePriceVersion.id).toBe('pv-1')
    expect(data.products[0]).not.toHaveProperty('priceVersions')
  })

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null as any)
    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
  })

  it('returns 404 when user not found', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
    const res = await GET(makeRequest())
    expect(res.status).toBe(404)
  })
})

describe('POST /api/products', () => {
  it('creates a product with a first active price version', async () => {
    vi.mocked(prisma.product.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.product.create).mockResolvedValue({
      id: 'prod-1',
      userId: 'user-1',
      name: 'Widget',
      priceUsdc: '10.000000',
      unit: 'item',
    } as any)
    vi.mocked(prisma.productPriceVersion.create).mockResolvedValue({
      id: 'pv-1',
      productId: 'prod-1',
      priceUsdc: '10.000000',
      isActive: true,
    } as any)

    const res = await POST(makeRequest('POST', { name: 'Widget', price: 10 }))
    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data.id).toBe('prod-1')
    expect(data.activePriceVersion.id).toBe('pv-1')
    expect(vi.mocked(prisma.productPriceVersion.create)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ productId: 'prod-1', priceUsdc: 10, isActive: true }),
      })
    )
  })

  it('rejects a negative price', async () => {
    const res = await POST(makeRequest('POST', { name: 'Widget', price: -1 }))
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toBe('Invalid request body')
  })

  it('rejects a duplicate name for the same user', async () => {
    vi.mocked(prisma.product.findFirst).mockResolvedValue({ id: 'prod-existing' } as any)
    const res = await POST(makeRequest('POST', { name: 'Widget', price: 10 }))
    expect(res.status).toBe(409)
    const data = await res.json()
    expect(data.error).toBe('A product with this name already exists')
  })

  it('returns 400 for invalid JSON body', async () => {
    const req = new NextRequest('http://localhost/api/products', {
      method: 'POST',
      headers: { authorization: 'Bearer token' },
      body: 'not json',
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toBe('Invalid JSON body')
  })

  it('returns 400 when name is missing', async () => {
    const res = await POST(makeRequest('POST', { price: 10 }))
    expect(res.status).toBe(400)
  })

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null as any)
    const res = await POST(makeRequest('POST', { name: 'Widget', price: 10 }))
    expect(res.status).toBe(401)
  })
})
