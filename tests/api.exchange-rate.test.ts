import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from '@/app/api/exchange-rate/route'
import { getUsdToNgnRate } from '@/lib/exchange-rate'

vi.mock('@/lib/exchange-rate', () => ({
  getUsdToNgnRate: vi.fn(),
}))

describe('GET /api/exchange-rate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the rate with its cache age so clients can judge freshness', async () => {
    vi.mocked(getUsdToNgnRate).mockResolvedValue({
      rate: 1550,
      lastUpdated: '2026-01-01T00:00:00.000Z',
      fromCache: true,
      cacheAgeMs: 45_000,
    })

    const res = await GET()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({
      rate: 1550,
      currency: 'NGN',
      cacheAgeMs: 45_000,
      cacheAgeSeconds: 45,
    })
  })
})
