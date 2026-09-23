import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    referralEarning: { aggregate: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUser = { id: 'user-1' }
const mockClaims = { userId: 'privy-1' }

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/referral-earnings/tiers', {
    headers: { authorization: 'Bearer token' },
  })
}

function mockVolume(sum: string | null) {
  vi.mocked(prisma.referralEarning.aggregate).mockResolvedValue({ _sum: { amountUsdc: sum } } as any)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
  mockVolume('1500.000000')
})

describe('GET /api/referral-earnings/tiers', () => {
  it('excludes clawed_back rows from the volume aggregate', async () => {
    await GET(makeRequest())
    const where = vi.mocked(prisma.referralEarning.aggregate).mock.calls[0][0].where
    expect(where).toEqual({ referrerId: 'user-1', status: { not: 'clawed_back' } })
  })

  it('returns the current tier and volume needed for the next tier', async () => {
    const res = await GET(makeRequest())
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.currentTier.tier).toBe('silver')
    expect(data.nextTier.tier).toBe('gold')
    expect(data.nextTier.volumeToNextTier).toBe(3500)
    expect(data.volumeUsdc).toBe('1500.000000')
  })

  it('returns the bronze tier at zero volume', async () => {
    mockVolume(null)
    const res = await GET(makeRequest())
    const data = await res.json()

    expect(data.currentTier.tier).toBe('bronze')
    expect(data.nextTier.tier).toBe('silver')
    expect(data.nextTier.volumeToNextTier).toBe(1000)
  })

  it('returns no next tier when at the top tier', async () => {
    mockVolume('30000.000000')
    const res = await GET(makeRequest())
    const data = await res.json()

    expect(data.currentTier.tier).toBe('platinum')
    expect(data.nextTier).toBeNull()
  })

  it('exposes the commission rate at each tier', async () => {
    const res = await GET(makeRequest())
    const data = await res.json()

    expect(data.tiers).toHaveLength(4)
    expect(data.tiers.map((t: any) => t.commissionRate)).toEqual([0.05, 0.07, 0.1, 0.15])
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await GET(new NextRequest('http://localhost/api/referral-earnings/tiers'))
    expect(res.status).toBe(401)
  })

  it('returns 500 on unexpected error', async () => {
    vi.mocked(prisma.referralEarning.aggregate).mockRejectedValue(new Error('DB error'))
    const res = await GET(makeRequest())
    expect(res.status).toBe(500)
  })
})
