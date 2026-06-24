import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const riskFindFirst = vi.fn()
const sanctionsFindUnique = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    riskAssessment: { findFirst: riskFindFirst },
    sanctionsScreening: { findUnique: sanctionsFindUnique },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

const URL = 'http://localhost/api/routes-d/risk/flags'

function makeGet(authHeader: string | null = 'Bearer tok') {
  return new NextRequest(URL, {
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

describe('GET /api/routes-d/risk/flags', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when unauthenticated', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-d/risk/flags/route')
    const res = await GET(makeGet(null))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
  })

  it('returns an empty list when the account has no active flags', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    riskFindFirst.mockResolvedValue(null)
    sanctionsFindUnique.mockResolvedValue({ status: 'clear', provider: 'ComplyAdvantage', matchScore: null, screenedAt: new Date('2026-06-20T00:00:00Z') })

    const { GET } = await import('@/app/api/routes-d/risk/flags/route')
    const res = await GET(makeGet())

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ flags: [] })
  })

  it('returns risk assessment and sanctions flags for the authenticated account', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    riskFindFirst.mockResolvedValue({
      riskScore: 72,
      status: 'pending_review',
      signals: { velocity: true, geography: 'high_risk' },
      createdAt: new Date('2026-06-21T00:00:00Z'),
    })
    sanctionsFindUnique.mockResolvedValue({
      status: 'under_review',
      provider: 'ComplyAdvantage',
      matchScore: 0.54,
      screenedAt: new Date('2026-06-23T00:00:00Z'),
    })

    const { GET } = await import('@/app/api/routes-d/risk/flags/route')
    const res = await GET(makeGet())

    expect(res.status).toBe(200)
    expect(riskFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { entityType: 'user', entityId: 'user_1' },
      }),
    )

    const body = await res.json()
    expect(body.flags).toHaveLength(2)
    expect(body.flags[0]).toMatchObject({
      code: 'manual_review',
      severity: 'medium',
      source: 'risk_assessment',
    })
    expect(body.flags[1]).toMatchObject({
      code: 'sanctions_screening',
      severity: 'medium',
      source: 'sanctions_screening',
    })
  })

  it('returns 500 when fetching risk flags fails', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    riskFindFirst.mockRejectedValue(new Error('db down'))

    const { GET } = await import('@/app/api/routes-d/risk/flags/route')
    const res = await GET(makeGet())

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to fetch risk flags' })
  })
})
