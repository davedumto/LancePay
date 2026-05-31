import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    userTrustScore: { findUnique: vi.fn() },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedTrustScoreFind = vi.mocked(prisma.userTrustScore.findUnique)

function makeRequest(auth = 'Bearer token'): NextRequest {
  return new NextRequest('http://localhost/api/routes-d/trust-score', {
    method: 'GET',
    headers: auth ? { authorization: auth } : {},
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
  mockedUserFind.mockResolvedValue({ id: 'user-1' } as never)
})

describe('GET /api/routes-d/trust-score', () => {
  it('returns 401 without auth header', async () => {
    const req = new NextRequest('http://localhost/api/routes-d/trust-score', { method: 'GET' })
    expect((await GET(req)).status).toBe(401)
  })

  it('returns 401 when token is invalid', async () => {
    mockedVerify.mockResolvedValue(null as never)
    expect((await GET(makeRequest())).status).toBe(401)
  })

  it('returns 401 when user not found', async () => {
    mockedUserFind.mockResolvedValue(null as never)
    expect((await GET(makeRequest())).status).toBe(401)
  })

  it('returns default trust score when no record exists', async () => {
    mockedTrustScoreFind.mockResolvedValue(null as never)

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)

    const json = await res.json()
    expect(json.trustScore.score).toBe(50)
    expect(json.trustScore.totalVolumeUsdc).toBe(0)
    expect(json.trustScore.disputeCount).toBe(0)
    expect(json.trustScore.tier).toBe('silver')
  })

  it('returns stored trust score when record exists', async () => {
    mockedTrustScoreFind.mockResolvedValue({
      score: 82,
      totalVolumeUsdc: 5000,
      disputeCount: 1,
    } as never)

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)

    const json = await res.json()
    expect(json.trustScore.score).toBe(82)
    expect(json.trustScore.totalVolumeUsdc).toBe(5000)
    expect(json.trustScore.disputeCount).toBe(1)
  })

  it('returns 500 on unexpected error', async () => {
    mockedUserFind.mockRejectedValue(new Error('DB down') as never)
    const res = await GET(makeRequest())
    expect(res.status).toBe(500)
  })
})
