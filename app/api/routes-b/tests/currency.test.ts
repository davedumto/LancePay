import { describe, it, expect, vi, beforeEach } from 'vitest'
import { toUSDC, aggregateGroups } from '../_lib/currency'
import * as cache from '../_lib/cache'

vi.mock('../_lib/cache', () => ({
  getCachedValue: vi.fn(),
  setCachedValue: vi.fn(),
}))

describe('currency normalization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('USDC pass-through', () => {
    const result = toUSDC(100, 'USDC')
    expect(result).toEqual({
      amount: 100,
      currency: 'USDC',
      normalized: true,
    })
  })

  it('USD pass-through', () => {
    const result = toUSDC(100, 'USD')
    expect(result).toEqual({
      amount: 100,
      currency: 'USDC',
      normalized: true,
    })
  })

  it('NGN conversion', () => {
    vi.mocked(cache.getCachedValue).mockReturnValue({ value: 0.0006 })
    const result = toUSDC(1000, 'NGN')
    expect(result).toEqual({
      amount: 0.6,
      currency: 'USDC',
      normalized: true,
    })
    expect(cache.getCachedValue).toHaveBeenCalledWith('exchange-rate:NGN:USDC')
  })

  it('unknown currency rejected (marked as not normalized)', () => {
    vi.mocked(cache.getCachedValue).mockReturnValue(null)
    const result = toUSDC(100, 'XYZ')
    expect(result).toEqual({
      amount: 100,
      currency: 'XYZ',
      normalized: false,
    })
  })

  it('rate-unavailable fallback', () => {
    vi.mocked(cache.getCachedValue).mockReturnValue(null)
    const groups = [
      { currency: 'USDC', _sum: { amount: 100 } },
      { currency: 'NGN', _sum: { amount: 1000 } },
    ]
    const result = aggregateGroups(groups)
    expect(result).toEqual({
      USDC: 100,
      NGN: 1000,
    })
  })

  it('full normalization success', () => {
    vi.mocked(cache.getCachedValue).mockImplementation((key) => {
      if (key === 'exchange-rate:NGN:USDC') return { value: 0.0006 }
      return null
    })
    const groups = [
      { currency: 'USDC', _sum: { amount: 100 } },
      { currency: 'NGN', _sum: { amount: 1000 } },
    ]
    const result = aggregateGroups(groups)
    expect(result).toBe(100.6)
  })
})
