import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { mockPrisma, mockVerifyAuthToken } = vi.hoisted(() => ({
  mockPrisma: {
    fxRateSnapshot: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
  },
  mockVerifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: mockVerifyAuthToken }))

import { GET, POST } from './route'

function makeGetRequest(params = '', token: string | null = 'valid-token'): NextRequest {
  const url = `http://localhost/api/fx-rate-snapshots${params ? `?${params}` : ''}`
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest(url, { method: 'GET', headers })
}

function makePostRequest(body: unknown, token: string | null = 'valid-token'): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest('http://localhost/api/fx-rate-snapshots', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

describe('GET /api/fx-rate-snapshots', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'user-1', email: 'user@lancepay.io' })
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await GET(makeGetRequest('', null))
    expect(res.status).toBe(401)
  })

  it('returns paginated FX rate snapshots filtered by currency pair', async () => {
    const mockSnapshots = [
      {
        id: 'snap-1',
        fromCurrency: 'USDC',
        toCurrency: 'NGN',
        rate: 1625.5,
        source: 'coingecko',
        capturedAt: new Date('2026-03-01T12:00:00Z'),
        createdAt: new Date('2026-03-01T12:00:00Z'),
      },
    ]
    mockPrisma.fxRateSnapshot.findMany.mockResolvedValueOnce(mockSnapshots)
    mockPrisma.fxRateSnapshot.count.mockResolvedValueOnce(1)

    const res = await GET(makeGetRequest('fromCurrency=usdc&toCurrency=ngn'))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.data).toHaveLength(1)
    expect(body.latest.rate).toBe(1625.5)
    expect(body.pagination.total).toBe(1)
    expect(mockPrisma.fxRateSnapshot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { fromCurrency: 'USDC', toCurrency: 'NGN' },
      }),
    )
  })

  it('returns 400 when startDate is after endDate', async () => {
    const res = await GET(
      makeGetRequest('startDate=2026-03-10T00:00:00Z&endDate=2026-03-01T00:00:00Z'),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('startDate cannot be after endDate')
  })
})

describe('POST /api/fx-rate-snapshots', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'user-1', email: 'ops@lancepay.io' })
    mockPrisma.fxRateSnapshot.findFirst.mockResolvedValue(null)
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await POST(
      makePostRequest({ fromCurrency: 'USDC', toCurrency: 'NGN', rate: 1600, source: 'manual' }, null),
    )
    expect(res.status).toBe(401)
  })

  it('returns 400 when fromCurrency and toCurrency are identical', async () => {
    const res = await POST(
      makePostRequest({ fromCurrency: 'USDC', toCurrency: 'USDC', rate: 1, source: 'manual' }),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('must be different')
  })

  it('returns 400 when rate is non-positive or source is missing', async () => {
    const resNeg = await POST(
      makePostRequest({ fromCurrency: 'USDC', toCurrency: 'NGN', rate: -10, source: 'manual' }),
    )
    expect(resNeg.status).toBe(400)

    const resNoSource = await POST(
      makePostRequest({ fromCurrency: 'USDC', toCurrency: 'NGN', rate: 1600, source: '' }),
    )
    expect(resNoSource.status).toBe(400)
  })

  it('returns 422 when rate deviates by more than 50% from previous snapshot without force=true', async () => {
    mockPrisma.fxRateSnapshot.findFirst.mockResolvedValueOnce({
      id: 'snap-prev',
      fromCurrency: 'USDC',
      toCurrency: 'NGN',
      rate: 1600,
      source: 'coingecko',
      capturedAt: new Date(),
    })

    const res = await POST(
      makePostRequest({ fromCurrency: 'USDC', toCurrency: 'NGN', rate: 3000, source: 'coingecko' }),
    )
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toContain('deviates by more than 50%')
    expect(body.previousRate).toBe(1600)
  })

  it('creates an FX rate snapshot and returns 201', async () => {
    const created = {
      id: 'snap-new',
      fromCurrency: 'USDC',
      toCurrency: 'NGN',
      rate: 1630.25,
      source: 'coingecko',
      capturedAt: new Date('2026-03-01T12:05:00Z'),
      createdAt: new Date('2026-03-01T12:05:00Z'),
    }
    mockPrisma.fxRateSnapshot.create.mockResolvedValueOnce(created)

    const res = await POST(
      makePostRequest({
        fromCurrency: 'usdc',
        toCurrency: 'ngn',
        rate: 1630.25,
        source: 'coingecko',
      }),
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.snapshot.id).toBe('snap-new')
    expect(body.snapshot.rate).toBe(1630.25)
  })
})
