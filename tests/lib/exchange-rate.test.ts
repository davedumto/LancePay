import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// API_KEY is captured at module load, so each test re-imports the module
// after stubbing the environment.
async function importModule() {
  vi.resetModules()
  return import('@/lib/exchange-rate')
}

function mockRateFetch(rate = 1600) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ conversion_rates: { NGN: rate } }),
  })
}

describe('exchange-rate cache TTL', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('pins the TTL constant to the documented 60 seconds', async () => {
    const { EXCHANGE_RATE_CACHE_TTL_MS } = await importModule()
    expect(EXCHANGE_RATE_CACHE_TTL_MS).toBe(60 * 1000)
  })

  it('fetches with a revalidate window derived from the same TTL', async () => {
    vi.stubEnv('EXCHANGE_RATE_API_KEY', 'key')
    const fetchMock = mockRateFetch(1550)
    vi.stubGlobal('fetch', fetchMock)
    const { getUsdToNgnRate } = await importModule()

    await getUsdToNgnRate()

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('exchangerate-api.com'),
      expect.objectContaining({ next: { revalidate: 60 } }),
    )
  })

  it('serves cached rates within the TTL and reports cache age', async () => {
    vi.stubEnv('EXCHANGE_RATE_API_KEY', 'key')
    const fetchMock = mockRateFetch(1550)
    vi.stubGlobal('fetch', fetchMock)
    const { getUsdToNgnRate, EXCHANGE_RATE_CACHE_TTL_MS } = await importModule()

    const first = await getUsdToNgnRate()
    expect(first).toMatchObject({ rate: 1550, fromCache: false, cacheAgeMs: 0 })

    vi.advanceTimersByTime(30_000)
    const second = await getUsdToNgnRate()
    expect(second.fromCache).toBe(true)
    expect(second.rate).toBe(1550)
    expect(second.cacheAgeMs).toBeGreaterThanOrEqual(30_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Just past the TTL the rate is fetched again.
    vi.advanceTimersByTime(EXCHANGE_RATE_CACHE_TTL_MS)
    await getUsdToNgnRate()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns the fallback rate when no API key is configured', async () => {
    vi.stubEnv('EXCHANGE_RATE_API_KEY', '')
    const { getUsdToNgnRate } = await importModule()

    const result = await getUsdToNgnRate()
    expect(result).toMatchObject({ rate: 1600, fallback: true })
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it('falls back when the provider request fails', async () => {
    vi.stubEnv('EXCHANGE_RATE_API_KEY', 'key')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    )
    const { getUsdToNgnRate } = await importModule()

    const result = await getUsdToNgnRate()
    expect(result).toMatchObject({ rate: 1600, fallback: true })
  })

  it('serves the stale cached rate with its real age when the provider fails after expiry', async () => {
    vi.stubEnv('EXCHANGE_RATE_API_KEY', 'key')
    const fetchMock = mockRateFetch(1700)
    vi.stubGlobal('fetch', fetchMock)
    const { getUsdToNgnRate, EXCHANGE_RATE_CACHE_TTL_MS } = await importModule()

    await getUsdToNgnRate()
    vi.advanceTimersByTime(EXCHANGE_RATE_CACHE_TTL_MS + 5_000)
    fetchMock.mockResolvedValue({ ok: false, status: 503 })

    const result = await getUsdToNgnRate()
    expect(result.rate).toBe(1700) // stale cache beats the constant
    expect(result.fallback).toBe(true)
    expect(result.cacheAgeMs).toBeGreaterThanOrEqual(EXCHANGE_RATE_CACHE_TTL_MS)
  })
})
