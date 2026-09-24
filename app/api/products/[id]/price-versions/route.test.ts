import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET, POST } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    product: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    productPriceVersion: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
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
const mockProduct = { id: 'prod-1', userId: 'user-1', name: 'Widget' }

function makeRequest(method: string = 'GET', body?: any): NextRequest {
  return new NextRequest('http://localhost/api/products/prod-1/price-versions', {
    method,
    headers: { authorization: 'Bearer token' },
    body: body ? JSON.stringify(body) : undefined,
  })
}

const paramsFor = (id = 'prod-1') => ({ params: Promise.resolve({ id }) })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
  vi.mocked(prisma.product.findFirst).mockResolvedValue(mockProduct as any)
  vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(prisma))
})

describe('GET /api/products/[id]/price-versions', () => {
  it('lists every price version for the product', async () => {
    vi.mocked(prisma.productPriceVersion.findMany).mockResolvedValue([
      { id: 'pv-2', isActive: true },
      { id: 'pv-1', isActive: false },
    ] as any)

    const res = await GET(makeRequest(), paramsFor())
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.priceVersions).toHaveLength(2)
  })

  it('returns 404 when the product does not belong to the user', async () => {
    vi.mocked(prisma.product.findFirst).mockResolvedValue(null)
    const res = await GET(makeRequest(), paramsFor())
    expect(res.status).toBe(404)
  })
})

describe('POST /api/products/[id]/price-versions', () => {
  it('adds an active version now and supersedes the previous active one', async () => {
    vi.mocked(prisma.productPriceVersion.updateMany).mockResolvedValue({ count: 1 } as any)
    vi.mocked(prisma.productPriceVersion.create).mockResolvedValue({
      id: 'pv-2',
      productId: 'prod-1',
      priceUsdc: 20,
      isActive: true,
    } as any)
    vi.mocked(prisma.product.update).mockResolvedValue({} as any)

    const res = await POST(makeRequest('POST', { price: 20 }), paramsFor())
    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data.isActive).toBe(true)
    expect(vi.mocked(prisma.productPriceVersion.updateMany)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { productId: 'prod-1', isActive: true },
        data: { isActive: false },
      })
    )
    expect(vi.mocked(prisma.product.update)).toHaveBeenCalled()
  })

  it('stores a future-dated version as inactive without touching the active one', async () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    vi.mocked(prisma.productPriceVersion.create).mockResolvedValue({
      id: 'pv-3',
      isActive: false,
    } as any)

    const res = await POST(makeRequest('POST', { price: 30, effectiveDate: future }), paramsFor())
    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data.isActive).toBe(false)
    expect(vi.mocked(prisma.productPriceVersion.updateMany)).not.toHaveBeenCalled()
    expect(vi.mocked(prisma.product.update)).not.toHaveBeenCalled()
  })

  it('rejects a negative price', async () => {
    const res = await POST(makeRequest('POST', { price: -5 }), paramsFor())
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toBe('Invalid request body')
  })

  it('returns 404 when the product does not belong to the user', async () => {
    vi.mocked(prisma.product.findFirst).mockResolvedValue(null)
    const res = await POST(makeRequest('POST', { price: 20 }), paramsFor())
    expect(res.status).toBe(404)
  })

  it('returns 400 for invalid JSON body', async () => {
    const req = new NextRequest('http://localhost/api/products/prod-1/price-versions', {
      method: 'POST',
      headers: { authorization: 'Bearer token' },
      body: 'not json',
    })
    const res = await POST(req, paramsFor())
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toBe('Invalid JSON body')
  })

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null as any)
    const res = await POST(makeRequest('POST', { price: 20 }), paramsFor())
    expect(res.status).toBe(401)
  })
})
