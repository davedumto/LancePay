import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { mockPrisma, mockVerifyAuthToken } = vi.hoisted(() => ({
  mockPrisma: {
    fxRateSnapshot: {
      findMany: vi.fn(),
    },
  },
  mockVerifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: mockVerifyAuthToken }))

import { GET } from './route'

function makeRequest(params = '', token: string | null = 'valid-token'): NextRequest {
  const url = `http://localhost/api/fx-rate-snapshots/staleness-check${params ? `?${params}` : ''}`
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest(url, { method: 'GET', headers })
}

describe('GET /api/fx-rate-snapshots/staleness-check', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({
      userId: 'user-1',
      email: 'ops@lancepay.io',
      role: 'admin',
    })
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await GET(makeRequest('', null))
    expect(res.status).toBe(401)
  })

  it('returns 400 when maxAgeMinutes is invalid', async () => {
    const res = await GET(makeRequest('maxAgeMinutes=-5'))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('maxAgeMinutes')
  })

  it('returns 400 when pair format is invalid', async () => {
    const res = await GET(makeRequest('pair=INVALIDPAIR'))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('pair must be formatted as FROM/TO')
  })

  it('evaluates latest snapshot per pair and distinguishes fresh vs stale rates', async () => {
    const now = Date.now()
    const fiveMinAgo = new Date(now - 5 * 60 * 1000)
    const thirtyMinAgo = new Date(now - 30 * 60 * 1000)
    const sixtyMinAgo = new Date(now - 60 * 60 * 1000)

    mockPrisma.fxRateSnapshot.findMany.mockResolvedValueOnce([
      {
        id: 'snap-usdc-ngn-latest',
        fromCurrency: 'USDC',
        toCurrency: 'NGN',
        rate: 1620.5,
        source: 'coingecko',
        capturedAt: fiveMinAgo,
      },
      {
        id: 'snap-usdc-ngn-older',
        fromCurrency: 'USDC',
        toCurrency: 'NGN',
        rate: 1615.0,
        source: 'coingecko',
        capturedAt: sixtyMinAgo,
      },
      {
        id: 'snap-usdc-kes-stale',
        fromCurrency: 'USDC',
        toCurrency: 'KES',
        rate: 129.25,
        source: 'openexchangerates',
        capturedAt: thirtyMinAgo,
      },
    ])

    const res = await GET(makeRequest('maxAgeMinutes=15'))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.isStale).toBe(true)
    expect(body.healthy).toBe(false)
    expect(body.summary.totalPairs).toBe(2)
    expect(body.summary.freshCount).toBe(1)
    expect(body.summary.staleCount).toBe(1)

    const ngnPair = body.pairs.find((p: { pair: string }) => p.pair === 'USDC/NGN')
    expect(ngnPair.latestSnapshotId).toBe('snap-usdc-ngn-latest')
    expect(ngnPair.isStale).toBe(false)
    expect(ngnPair.status).toBe('fresh')

    const kesPair = body.pairs.find((p: { pair: string }) => p.pair === 'USDC/KES')
    expect(kesPair.latestSnapshotId).toBe('snap-usdc-kes-stale')
    expect(kesPair.isStale).toBe(true)
    expect(kesPair.status).toBe('stale')
  })

  it('reports status as missing and isStale true when a specific requested pair has no snapshot', async () => {
    mockPrisma.fxRateSnapshot.findMany.mockResolvedValueOnce([])

    const res = await GET(makeRequest('fromCurrency=USDC&toCurrency=GHS'))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.isStale).toBe(true)
    expect(body.summary.missingCount).toBe(1)
    expect(body.pairs[0]).toMatchObject({
      pair: 'USDC/GHS',
      latestSnapshotId: null,
      rate: null,
      isStale: true,
      status: 'missing',
    })
  })

  it('returns 500 when database query fails', async () => {
    mockPrisma.fxRateSnapshot.findMany.mockRejectedValueOnce(new Error('DB failure'))
    const res = await GET(makeRequest())
    expect(res.status).toBe(500)
  })
})
