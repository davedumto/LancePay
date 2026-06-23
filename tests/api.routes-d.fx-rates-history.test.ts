import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const snapshotFindMany = vi.fn()

vi.mock('@/lib/auth', () => ({
  verifyAuthToken,
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: userFindUnique,
    },
    fxRateSnapshot: {
      findMany: snapshotFindMany,
    },
  },
}))

function getRequest(query = ''): NextRequest {
  const suffix = query ? `?${query}` : ''
  return new NextRequest(`http://localhost/api/routes-d/fx/rates/history${suffix}`)
}

describe('GET /api/routes-d/fx/rates/history', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when the user is not authenticated', async () => {
    verifyAuthToken.mockResolvedValue(null)

    const { GET } = await import('@/app/api/routes-d/fx/rates/history/route')
    const response = await GET(getRequest('from=USD&to=NGN'))

    expect(response.status).toBe(401)
    expect(snapshotFindMany).not.toHaveBeenCalled()
  })

  it('returns 400 when the from / to currencies are missing', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })

    const { GET } = await import('@/app/api/routes-d/fx/rates/history/route')
    const response = await GET(getRequest('from=USD'))

    expect(response.status).toBe(400)
    expect(snapshotFindMany).not.toHaveBeenCalled()
  })

  it('returns 400 when from and to are the same currency', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })

    const { GET } = await import('@/app/api/routes-d/fx/rates/history/route')
    const response = await GET(getRequest('from=USD&to=usd'))

    expect(response.status).toBe(400)
    expect(snapshotFindMany).not.toHaveBeenCalled()
  })

  it('clamps the limit and returns serialized snapshots', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    snapshotFindMany.mockResolvedValue([
      {
        capturedAt: new Date('2026-06-22T00:00:00Z'),
        rate: { toString: () => '1500.12345678' },
        source: 'exchangerate-api',
      },
      {
        capturedAt: new Date('2026-06-23T00:00:00Z'),
        rate: { toString: () => '1505.50000000' },
        source: 'exchangerate-api',
      },
    ])

    const { GET } = await import('@/app/api/routes-d/fx/rates/history/route')
    const response = await GET(getRequest('from=usd&to=ngn&limit=9999'))

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.from).toBe('USD')
    expect(body.to).toBe('NGN')
    expect(body.rates).toHaveLength(2)
    expect(body.rates[0].rate).toBe('1500.12345678')

    expect(snapshotFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 500, // clamped to MAX_LIMIT
        where: expect.objectContaining({
          fromCurrency: 'USD',
          toCurrency: 'NGN',
        }),
      }),
    )
  })
})
