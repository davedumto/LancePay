import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

const URL = 'http://localhost/api/routes-d/billing/plan'

function getReq() {
  return new NextRequest(URL, { headers: { authorization: 'Bearer tok' } })
}

describe('GET /api/routes-d/billing/plan', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when no auth token', async () => {
    const { GET } = await import('@/app/api/routes-d/billing/plan/route')
    const res = await GET(new NextRequest(URL))
    expect(res.status).toBe(401)
  })

  it('returns 401 when token is invalid', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-d/billing/plan/route')
    const res = await GET(getReq())
    expect(res.status).toBe(401)
  })

  it('returns 401 when user not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-d/billing/plan/route')
    const res = await GET(getReq())
    expect(res.status).toBe(401)
  })

  it('returns free plan when user has no subscription', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1', subscription: null })
    const { GET } = await import('@/app/api/routes-d/billing/plan/route')
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.plan).toBe('free')
    expect(body.monthlyPriceCents).toBe(0)
    expect(body.features).toBeInstanceOf(Array)
  })

  it('returns pro plan details when subscribed to pro', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({
      id: 'user_1',
      subscription: { plan: 'pro', status: 'active', renewsAt: '2026-07-25T00:00:00Z' },
    })
    const { GET } = await import('@/app/api/routes-d/billing/plan/route')
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.plan).toBe('pro')
    expect(body.monthlyPriceCents).toBe(4900)
    expect(body.displayName).toBe('Pro')
    expect(body.renewsAt).toBe('2026-07-25T00:00:00Z')
    expect(body.status).toBe('active')
  })

  it('returns enterprise plan with -1 price', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({
      id: 'user_1',
      subscription: { plan: 'enterprise', status: 'active', renewsAt: null },
    })
    const { GET } = await import('@/app/api/routes-d/billing/plan/route')
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.plan).toBe('enterprise')
    expect(body.monthlyPriceCents).toBe(-1)
  })
})
