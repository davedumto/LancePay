import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const getUsdToNgnRate = vi.fn()

vi.mock('@/lib/auth', () => ({
  verifyAuthToken,
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
  },
}))

vi.mock('@/lib/exchange-rate', () => ({
  getUsdToNgnRate,
}))

function getRequest(query = ''): NextRequest {
  const suffix = query ? `?${query}` : ''
  return new NextRequest(`http://localhost/api/routes-d/fx/quote${suffix}`)
}

describe('GET /api/routes-d/fx/quote', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when the user is not authenticated', async () => {
    verifyAuthToken.mockResolvedValue(null)

    const { GET } = await import('@/app/api/routes-d/fx/quote/route')
    const response = await GET(getRequest('from=USD&to=NGN&amount=100'))

    expect(response.status).toBe(401)
    expect(getUsdToNgnRate).not.toHaveBeenCalled()
  })

  it('rejects a missing amount', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })

    const { GET } = await import('@/app/api/routes-d/fx/quote/route')
    const response = await GET(getRequest('from=USD&to=NGN'))

    expect(response.status).toBe(400)
    expect(getUsdToNgnRate).not.toHaveBeenCalled()
  })

  it('rejects identical currencies', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })

    const { GET } = await import('@/app/api/routes-d/fx/quote/route')
    const response = await GET(getRequest('from=USD&to=usd&amount=100'))

    expect(response.status).toBe(400)
  })

  it('rejects unsupported FX pairs with the supported list', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })

    const { GET } = await import('@/app/api/routes-d/fx/quote/route')
    const response = await GET(getRequest('from=EUR&to=GBP&amount=100'))

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.supported).toContain('USD/NGN')
  })

  it('builds a USD/NGN quote with the platform spread applied', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1_deadbeef_extra' })
    getUsdToNgnRate.mockResolvedValue({ rate: 1600, fromCache: false, fallback: false })

    const { GET } = await import('@/app/api/routes-d/fx/quote/route')
    const response = await GET(getRequest('from=usd&to=ngn&amount=100'))

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.from).toBe('USD')
    expect(body.to).toBe('NGN')
    expect(body.amount).toBe('100.00')
    expect(body.midRate).toBe(1600)
    // 50bps spread: effective = 1600 * (1 - 0.005) = 1592
    expect(body.effectiveRate).toBeCloseTo(1592, 6)
    // fee = 100 * 1600 - 100 * 1592 = 800
    expect(body.fee.amount).toBeCloseTo(800, 2)
    expect(body.fee.bps).toBe(50)
    expect(body.netAmount).toBeCloseTo(159200, 2)
    expect(body.source).toBe('live')
  })

  it('reports a cached source when the lib returns fromCache=true', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    getUsdToNgnRate.mockResolvedValue({ rate: 1600, fromCache: true })

    const { GET } = await import('@/app/api/routes-d/fx/quote/route')
    const response = await GET(getRequest('from=USD&to=NGN&amount=100'))
    const body = await response.json()
    expect(body.source).toBe('cache')
  })

  it('reports a fallback source when the lib returns fallback=true', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    getUsdToNgnRate.mockResolvedValue({ rate: 1600, fallback: true })

    const { GET } = await import('@/app/api/routes-d/fx/quote/route')
    const response = await GET(getRequest('from=USD&to=NGN&amount=100'))
    const body = await response.json()
    expect(body.source).toBe('fallback')
  })
})
