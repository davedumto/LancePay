import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    product: { findFirst: vi.fn() },
    productPriceVersion: { findFirst: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUser = { id: 'user-1', privyId: 'privy-1' }
const mockClaims = { userId: 'privy-1' }
const mockProduct = { id: 'prod-1', userId: 'user-1' }

function makeRequest(url: string): NextRequest {
  return new NextRequest(url, { headers: { authorization: 'Bearer token' } })
}

const paramsFor = (id = 'prod-1') => ({ params: Promise.resolve({ id }) })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
  vi.mocked(prisma.product.findFirst).mockResolvedValue(mockProduct as any)
})

describe('GET /api/products/[id]/price-at', () => {
  it('returns the latest version effective on or before the requested date', async () => {
    vi.mocked(prisma.productPriceVersion.findFirst).mockResolvedValue({
      id: 'pv-1',
      priceUsdc: '10.000000',
      effectiveDate: '2026-01-01T00:00:00.000Z',
    } as any)

    const res = await GET(
      makeRequest('http://localhost/api/products/prod-1/price-at?date=2026-06-01T00:00:00.000Z'),
      paramsFor()
    )
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.priceVersion.id).toBe('pv-1')
    const call = vi.mocked(prisma.productPriceVersion.findFirst).mock.calls[0][0] as any
    expect(call.where.effectiveDate.lte).toBeInstanceOf(Date)
    expect(call.orderBy).toEqual({ effectiveDate: 'desc' })
  })

  it('defaults to the current date when no date parameter is supplied', async () => {
    vi.mocked(prisma.productPriceVersion.findFirst).mockResolvedValue({ id: 'pv-1' } as any)

    const res = await GET(makeRequest('http://localhost/api/products/prod-1/price-at'), paramsFor())
    expect(res.status).toBe(200)
    const call = vi.mocked(prisma.productPriceVersion.findFirst).mock.calls[0][0] as any
    const usedDate = call.where.effectiveDate.lte as Date
    expect(Math.abs(Date.now() - usedDate.getTime())).toBeLessThan(5000)
  })

  it('returns 404 when no version was effective at that date', async () => {
    vi.mocked(prisma.productPriceVersion.findFirst).mockResolvedValue(null)
    const res = await GET(
      makeRequest('http://localhost/api/products/prod-1/price-at?date=2000-01-01T00:00:00.000Z'),
      paramsFor()
    )
    expect(res.status).toBe(404)
  })

  it('returns 400 for an invalid date parameter', async () => {
    const res = await GET(
      makeRequest('http://localhost/api/products/prod-1/price-at?date=not-a-date'),
      paramsFor()
    )
    expect(res.status).toBe(400)
  })

  it('returns 404 when the product does not belong to the user', async () => {
    vi.mocked(prisma.product.findFirst).mockResolvedValue(null)
    const res = await GET(makeRequest('http://localhost/api/products/prod-1/price-at'), paramsFor())
    expect(res.status).toBe(404)
  })

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null as any)
    const res = await GET(makeRequest('http://localhost/api/products/prod-1/price-at'), paramsFor())
    expect(res.status).toBe(401)
  })
})
