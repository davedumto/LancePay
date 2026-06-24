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

const URL = 'http://localhost/api/routes-d/risk/score'

function makeGet(authHeader: string | null = 'Bearer tok') {
  return new NextRequest(URL, {
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

describe('GET /api/routes-d/risk/score', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when unauthenticated', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-d/risk/score/route')
    const res = await GET(makeGet(null))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
  })

  it('returns a default clear score when the account has no risk records', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    riskFindFirst.mockResolvedValue(null)
    sanctionsFindUnique.mockResolvedValue(null)

    const { GET } = await import('@/app/api/routes-d/risk/score/route')
    const res = await GET(makeGet())

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      riskScore: 0,
      status: 'clear',
      updatedAt: null,
      factors: {
        assessmentScore: null,
        assessmentStatus: null,
        sanctionsStatus: 'unscreened',
      },
    })
  })

  it('returns the higher sanctions-derived score when the account is flagged', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    riskFindFirst.mockResolvedValue({
      riskScore: 42,
      status: 'logged',
      createdAt: new Date('2026-06-20T00:00:00Z'),
    })
    sanctionsFindUnique.mockResolvedValue({
      status: 'flagged',
      screenedAt: new Date('2026-06-23T00:00:00Z'),
    })

    const { GET } = await import('@/app/api/routes-d/risk/score/route')
    const res = await GET(makeGet())

    expect(res.status).toBe(200)
    expect(riskFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { entityType: 'user', entityId: 'user_1' },
      }),
    )

    const body = await res.json()
    expect(body.riskScore).toBe(90)
    expect(body.status).toBe('flagged')
    expect(body.factors.assessmentScore).toBe(42)
    expect(body.factors.sanctionsStatus).toBe('flagged')
    expect(body.updatedAt).toBe('2026-06-23T00:00:00.000Z')
  })

  it('returns 500 when fetching risk data fails', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    riskFindFirst.mockRejectedValue(new Error('db down'))

    const { GET } = await import('@/app/api/routes-d/risk/score/route')
    const res = await GET(makeGet())

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to fetch risk score' })
  })
})
