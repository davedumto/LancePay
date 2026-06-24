import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { POST } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const userDelegate = prisma.user as unknown as { findUnique: ReturnType<typeof vi.fn> }

const BASE_URL = 'http://localhost/api/routes-d/gas/estimate'

function makePost(body: unknown, authHeader: string | null = 'Bearer token') {
  return new NextRequest(BASE_URL, {
    method: 'POST',
    headers: authHeader
      ? { authorization: authHeader, 'content-type': 'application/json' }
      : { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/routes-d/gas/estimate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedVerify.mockResolvedValue({ userId: 'user-privy-id' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1', privyId: 'user-privy-id' })
  })

  it('returns 401 when no auth header', async () => {
    const res = await POST(makePost({ network: 'ethereum', amount: 100 }, null))
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toBe('Unauthorized')
  })

  it('returns 401 when token invalid', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await POST(makePost({ network: 'ethereum', amount: 100 }))
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toBe('Invalid token')
  })

  it('returns 404 when user not found', async () => {
    userDelegate.findUnique.mockResolvedValue(null)
    const res = await POST(makePost({ network: 'ethereum', amount: 100 }))
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error).toBe('User not found')
  })

  it('returns 400 when network is missing', async () => {
    const res = await POST(makePost({ amount: 100 }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe('network is required')
  })

  it('returns 400 when network is invalid', async () => {
    const res = await POST(makePost({ network: 'solana', amount: 100 }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe('network must be one of: ethereum, polygon, bsc, arbitrum, optimism')
  })

  it('returns 400 when amount is missing', async () => {
    const res = await POST(makePost({ network: 'ethereum' }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe('amount must be a positive number')
  })

  it('returns 400 when amount is <= 0', async () => {
    const res = await POST(makePost({ network: 'ethereum', amount: 0 }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe('amount must be a positive number')
  })

  it('returns 200 with correct estimate for ethereum', async () => {
    const res = await POST(makePost({ network: 'ethereum', amount: 100, currency: 'USD' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.estimate.network).toBe('ethereum')
    expect(json.estimate.amount).toBe(100)
    expect(json.estimate.currency).toBe('USD')
    expect(json.estimate.baseFee).toBe(0.005)
    expect(json.estimate.priorityFee).toBe(0.002)
    expect(json.estimate.totalGasFee).toBe(0.007)
    expect(json.estimate.estimatedAt).toBeDefined()
  })

  it('returns 200 with default currency "USD" when not provided', async () => {
    const res = await POST(makePost({ network: 'polygon', amount: 50 }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.estimate.currency).toBe('USD')
  })

  it('returns 200 with correct totalGasFee = baseFee + priorityFee', async () => {
    const res = await POST(makePost({ network: 'arbitrum', amount: 200 }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.estimate.baseFee).toBe(0.001)
    expect(json.estimate.priorityFee).toBe(0.0005)
    expect(json.estimate.totalGasFee).toBe(0.0015)
  })
})
