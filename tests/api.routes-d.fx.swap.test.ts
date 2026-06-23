import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const fxRateSnapshotCreate = vi.fn()
const getUsdToNgnRate = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/exchange-rate', () => ({ getUsdToNgnRate }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    fxRateSnapshot: { create: fxRateSnapshotCreate },
  },
}))

const BASE_URL = 'http://localhost/api/routes-d/fx/swap'

function makeRequest(body: unknown) {
  return new NextRequest(BASE_URL, {
    method: 'POST',
    headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const mockUser = { id: 'user_abcdef12' }
const mockRate = { rate: 1600, fromCache: false, fallback: false }

describe('POST /api/routes-d/fx/swap', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    fxRateSnapshotCreate.mockResolvedValue({ id: 'snap_1' })
  })

  it('returns 401 when unauthenticated', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-d/fx/swap/route')
    const res = await POST(makeRequest({ amountUsd: 100 }))
    expect(res.status).toBe(401)
  })

  it('returns 400 when amountUsd is missing', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(mockUser)
    const { POST } = await import('@/app/api/routes-d/fx/swap/route')
    const res = await POST(makeRequest({}))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/amountUsd/i)
  })

  it('returns 400 for negative amount', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(mockUser)
    const { POST } = await import('@/app/api/routes-d/fx/swap/route')
    const res = await POST(makeRequest({ amountUsd: -10 }))
    expect(res.status).toBe(400)
  })

  it('returns 400 for amount exceeding max', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(mockUser)
    const { POST } = await import('@/app/api/routes-d/fx/swap/route')
    const res = await POST(makeRequest({ amountUsd: 200_000 }))
    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid quoteId format', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(mockUser)
    const { POST } = await import('@/app/api/routes-d/fx/swap/route')
    const res = await POST(makeRequest({ amountUsd: 100, quoteId: 'bad-id' }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/quoteId/i)
  })

  it('returns 409 when quote has expired', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(mockUser)
    const expiredTs = Date.now() - 200_000
    const { POST } = await import('@/app/api/routes-d/fx/swap/route')
    const res = await POST(makeRequest({ amountUsd: 100, quoteId: `q_${expiredTs}_abcdef12` }))
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.error).toMatch(/expired/i)
  })

  it('executes swap successfully and returns rate details', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(mockUser)
    getUsdToNgnRate.mockResolvedValue(mockRate)

    const { POST } = await import('@/app/api/routes-d/fx/swap/route')
    const res = await POST(makeRequest({ amountUsd: 100 }))
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.from.currency).toBe('USD')
    expect(json.from.amount).toBe(100)
    expect(json.to.currency).toBe('NGN')
    expect(json.to.amount).toBeGreaterThan(0)
    expect(json.fee.bps).toBe(50)
    expect(json.rateSnapshotId).toBe('snap_1')
    expect(fxRateSnapshotCreate).toHaveBeenCalledOnce()
  })

  it('accepts a valid non-expired quoteId', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(mockUser)
    getUsdToNgnRate.mockResolvedValue(mockRate)

    const freshTs = Date.now() - 5_000
    const { POST } = await import('@/app/api/routes-d/fx/swap/route')
    const res = await POST(makeRequest({ amountUsd: 50, quoteId: `q_${freshTs}_abcdef12` }))
    expect(res.status).toBe(201)
  })
})
