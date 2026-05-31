import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/exchange-rate', () => ({ getUsdToNgnRate: vi.fn() }))

import { getUsdToNgnRate } from '@/lib/exchange-rate'
import { GET } from '../route'

const mockedRate = vi.mocked(getUsdToNgnRate)

beforeEach(() => {
  vi.resetAllMocks()
})

describe('GET /api/routes-d/exchange-rate', () => {
  it('returns the USDC->NGN rate envelope', async () => {
    mockedRate.mockResolvedValue({
      rate: 1600,
      lastUpdated: '2026-05-26T00:00:00.000Z',
    } as never)

    const res = await GET()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.rate).toEqual({
      from: 'USDC',
      to: 'NGN',
      value: 1600,
      fetchedAt: '2026-05-26T00:00:00.000Z',
    })
  })

  it('returns 503 when the rate source falls back', async () => {
    mockedRate.mockResolvedValue({ fallback: true } as never)
    expect((await GET()).status).toBe(503)
  })
})
