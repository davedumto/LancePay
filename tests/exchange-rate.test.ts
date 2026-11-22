import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  getUsdToNgnRate,
  resetExchangeRateCache,
  setCachedExchangeRate,
  FALLBACK_RATE,
  CACHE_DURATION,
} from '@/lib/exchange-rate'

describe('getUsdToNgnRate - Deduplication & Stale-While-Revalidate', () => {
  const originalEnv = process.env.EXCHANGE_RATE_API_KEY
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    resetExchangeRateCache()
    process.env.EXCHANGE_RATE_API_KEY = 'test_api_key'
    vi.clearAllMocks()
  })

  afterEach(() => {
    process.env.EXCHANGE_RATE_API_KEY = originalEnv
    globalThis.fetch = originalFetch
    resetExchangeRateCache()
  })

  it('fetches fresh exchange rate on cold cache', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        conversion_rates: { NGN: 1550.75 },
      }),
    })
    globalThis.fetch = fetchMock

    const result = await getUsdToNgnRate()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.rate).toBe(1550.75)
    expect(result.fromCache).toBe(false)
    expect(result.fallback).toBeUndefined()
  })

  it('serves rate from cache without refetching when within TTL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        conversion_rates: { NGN: 1550.75 },
      }),
    })
    globalThis.fetch = fetchMock

    // First call populates cache
    const first = await getUsdToNgnRate()
    expect(first.fromCache).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Second call within TTL
    const second = await getUsdToNgnRate()
    expect(second.fromCache).toBe(true)
    expect(second.rate).toBe(1550.75)
    expect(fetchMock).toHaveBeenCalledTimes(1) // Still 1
  })

  it('deduplicates concurrent cold calls into a single in-flight fetch', async () => {
    let resolveFetch: (val: any) => void = () => {}
    const delayedPromise = new Promise((resolve) => {
      resolveFetch = resolve
    })

    const fetchMock = vi.fn().mockImplementation(() => delayedPromise)
    globalThis.fetch = fetchMock

    // Trigger 10 concurrent requests simultaneously
    const calls = Array.from({ length: 10 }, () => getUsdToNgnRate())

    // Ensure fetch was only called once
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Resolve the single in-flight network request
    resolveFetch({
      ok: true,
      json: async () => ({
        conversion_rates: { NGN: 1575.5 },
      }),
    })

    const results = await Promise.all(calls)

    // All 10 callers receive the identical result from the single fetch
    expect(fetchMock).toHaveBeenCalledTimes(1)
    for (const res of results) {
      expect(res.rate).toBe(1575.5)
      expect(res.fromCache).toBe(false)
    }
  })

  it('serves stale cached rate on refresh failure instead of jumping to fallback', async () => {
    // Seed an expired cached rate from 20 minutes ago (TTL is 15 minutes)
    const twentyMinutesAgo = Date.now() - (CACHE_DURATION + 5 * 60 * 1000)
    setCachedExchangeRate(1520.0, twentyMinutesAgo)

    // Mock fetch to simulate network or provider failure
    const fetchMock = vi.fn().mockRejectedValue(new Error('500 Service Unavailable'))
    globalThis.fetch = fetchMock

    const result = await getUsdToNgnRate()

    // Must have attempted to refresh
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Resiliency: served last good rate as stale rather than fallback rate
    expect(result.rate).toBe(1520.0)
    expect(result.fromCache).toBe(true)
    expect(result.stale).toBe(true)
    expect(result.fallback).toBeUndefined()
  })

  it('serves fallback rate when cold cache fetch fails with no prior rate', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('Network error'))
    globalThis.fetch = fetchMock

    const result = await getUsdToNgnRate()

    expect(result.rate).toBe(FALLBACK_RATE)
    expect(result.fallback).toBe(true)
    expect(result.fromCache).toBe(false)
  })

  it('returns fallback rate when EXCHANGE_RATE_API_KEY is not configured', async () => {
    delete process.env.EXCHANGE_RATE_API_KEY

    const result = await getUsdToNgnRate()

    expect(result.rate).toBe(FALLBACK_RATE)
    expect(result.fallback).toBe(true)
  })
})
