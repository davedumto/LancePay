import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import {
  MemoryRateLimitStore,
  RedisRateLimitStore,
  RouteRateLimiter,
  buildRateLimitResponse,
  checkRequestRateLimit,
  getRateLimitStore,
  isKycRateLimitBypassed,
  kycSubmitHourly,
  kycSubmitDaily,
  kycSubmitGlobal,
  kycStatusLimiter,
  resetRateLimitStoreForTests,
  type RedisEvalClient,
} from '@/lib/rate-limit'

/** In-memory fake implementing the Redis EVAL surface used by the Lua scripts. */
function createFakeRedisClient() {
  const hashes = new Map<string, { count: number; resetAt: number }>()
  const expiries = new Map<string, number>()

  const client: RedisEvalClient = {
    async eval(script: string, keys: string[], args: Array<string | number>) {
      const key = keys[0]
      if (script.includes('HMGET') && script.includes('PEXPIRE')) {
        // CONSUME_SCRIPT
        const limit = Number(args[0])
        const windowMs = Number(args[1])
        const now = Number(args[2])
        const existing = hashes.get(key)
        let count = 0
        let resetAt = 0
        let counted = 0
        if (!existing || existing.resetAt <= now) {
          resetAt = now + windowMs
          count = 1
          counted = 1
        } else if (existing.count < limit) {
          count = existing.count + 1
          resetAt = existing.resetAt
          counted = 1
        } else {
          count = existing.count
          resetAt = existing.resetAt
        }
        hashes.set(key, { count, resetAt })
        expiries.set(key, windowMs + 1000)
        return [count, resetAt, counted]
      }
      if (script.includes('HMGET') && !script.includes('HMSET')) {
        // PEEK_SCRIPT
        const now = Number(args[0])
        const existing = hashes.get(key)
        if (!existing || existing.resetAt <= now) return null
        return [existing.count, existing.resetAt]
      }
      if (script.includes("redis.call('DEL'")) {
        hashes.delete(key)
        expiries.delete(key)
        return 1
      }
      throw new Error(`unexpected script: ${script}`)
    },
  }
  return { client, hashes, expiries }
}

describe('MemoryRateLimitStore', () => {
  it('counts up to the limit then rejects without incrementing', async () => {
    const store = new MemoryRateLimitStore()
    const now = Date.now()
    const results = await Promise.all(
      Array.from({ length: 5 }, () => store.consume('k', 3, 60_000, now)),
    )
    expect(results.filter((r) => r.counted)).toHaveLength(3)
    expect(results.filter((r) => !r.counted)).toHaveLength(2)
    const peeked = await store.peek('k', now)
    expect(peeked?.count).toBe(3)
  })

  it('starts a new window after expiry', async () => {
    const store = new MemoryRateLimitStore()
    const t0 = Date.now()
    await store.consume('k', 1, 1000, t0)
    const blocked = await store.consume('k', 1, 1000, t0 + 10)
    expect(blocked.counted).toBe(false)
    const fresh = await store.consume('k', 1, 1000, t0 + 2000)
    expect(fresh.counted).toBe(true)
    expect(fresh.count).toBe(1)
  })
})

describe('RedisRateLimitStore', () => {
  it('behaves identically to the memory store via a fake redis client', async () => {
    const { client } = createFakeRedisClient()
    const store = new RedisRateLimitStore(client)
    const now = Date.now()

    const r1 = await store.consume('k', 2, 60_000, now)
    const r2 = await store.consume('k', 2, 60_000, now)
    const r3 = await store.consume('k', 2, 60_000, now)

    expect(r1).toMatchObject({ count: 1, counted: true })
    expect(r2).toMatchObject({ count: 2, counted: true })
    expect(r3).toMatchObject({ count: 2, counted: false })
    expect(r1.resetAt).toBe(now + 60_000)

    expect(await store.peek('k', now)).toEqual({ count: 2, resetAt: now + 60_000 })
    expect(await store.peek('k', now + 60_001)).toBeNull()

    await store.delete('k')
    expect(await store.peek('k', now)).toBeNull()
  })
})

describe('RouteRateLimiter', () => {
  let limiter: RouteRateLimiter

  beforeEach(() => {
    resetRateLimitStoreForTests()
    limiter = new RouteRateLimiter({ id: `test-${Date.now()}-${Math.random()}`, maxRequests: 3, windowMs: 60_000 })
  })

  it('allows requests under the limit', async () => {
    const r1 = await limiter.check('user-1')
    expect(r1.allowed).toBe(true)
    expect(r1.limit).toBe(3)
    expect(r1.remaining).toBe(2)
  })

  it('blocks after limit is reached', async () => {
    await limiter.check('user-1')
    await limiter.check('user-1')
    await limiter.check('user-1')
    const r4 = await limiter.check('user-1')
    expect(r4.allowed).toBe(false)
    expect(r4.remaining).toBe(0)
  })

  it('limits are per-identifier (no cross-contamination)', async () => {
    await limiter.check('user-1')
    await limiter.check('user-1')
    await limiter.check('user-1')
    const r = await limiter.check('user-2')
    expect(r.allowed).toBe(true)
  })

  it('resets counter after window expires', async () => {
    const fastLimiter = new RouteRateLimiter({ id: `fast-${Date.now()}-${Math.random()}`, maxRequests: 1, windowMs: 50 })
    await fastLimiter.check('user-1')
    expect((await fastLimiter.check('user-1')).allowed).toBe(false)
    await new Promise((r) => setTimeout(r, 60))
    expect((await fastLimiter.check('user-1')).allowed).toBe(true)
  })

  it('reset() clears the counter for an identifier', async () => {
    await limiter.check('user-1')
    await limiter.check('user-1')
    await limiter.check('user-1')
    await limiter.reset('user-1')
    expect((await limiter.check('user-1')).allowed).toBe(true)
  })
})

describe('anonymous client fallback', () => {
  function bareRequest(path = '/api/auth/session') {
    return new NextRequest(`http://localhost${path}`)
  }

  beforeEach(() => {
    resetRateLimitStoreForTests()
  })

  it('applies the stricter anonymous policy when no IP headers exist', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // api-auth anonymousMaxRequests = 5
    for (let i = 0; i < 5; i++) {
      const res = await checkRequestRateLimit(bareRequest())
      expect(res?.allowed).toBe(true)
      expect(res?.limit).toBe(5)
    }
    const blocked = await checkRequestRateLimit(bareRequest())
    expect(blocked?.allowed).toBe(false)
    expect(blocked?.limit).toBe(5)
    // Logged once per window, not per request.
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('two different headerless clients share the stricter anonymous bucket', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Both requests carry no IP headers; they cannot be told apart, so they
    // share the same strict bucket rather than the per-IP allowance.
    for (let i = 0; i < 5; i++) {
      await checkRequestRateLimit(bareRequest())
    }
    const blocked = await checkRequestRateLimit(bareRequest('/api/auth/other'))
    expect(blocked?.allowed).toBe(false)
    vi.restoreAllMocks()
  })

  it('identified clients get the full policy limit', async () => {
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`
    const req = () =>
      new NextRequest('http://localhost/api/auth/session', {
        headers: { 'x-real-ip': ip },
      })
    for (let i = 0; i < 5; i++) {
      const res = await checkRequestRateLimit(req())
      expect(res?.allowed).toBe(true)
      expect(res?.limit).toBe(30)
    }
  })
})

describe('buildRateLimitResponse', () => {
  it('returns 429 status', async () => {
    const result = { policyId: 'test', allowed: false, limit: 3, remaining: 0, resetAt: Date.now() + 60_000 }
    const response = buildRateLimitResponse(result)
    expect(response.status).toBe(429)
  })

  it('includes required rate-limit headers', async () => {
    const resetAt = Date.now() + 60_000
    const result = { policyId: 'test', allowed: false, limit: 3, remaining: 0, resetAt }
    const response = buildRateLimitResponse(result)
    expect(response.headers.get('X-RateLimit-Limit')).toBe('3')
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('0')
    expect(response.headers.get('X-RateLimit-Reset')).toBe(resetAt.toString())
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0)
  })

  it('response body contains error and resetAt ISO string', async () => {
    const result = { policyId: 'test', allowed: false, limit: 3, remaining: 0, resetAt: Date.now() + 60_000 }
    const response = buildRateLimitResponse(result)
    const body = await response.json()
    expect(body.error).toMatch(/rate limit/i)
    expect(body.resetAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

describe('getRateLimitStore', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    resetRateLimitStoreForTests()
  })

  it('defaults to the memory store', async () => {
    const store = await getRateLimitStore()
    expect(store).toBeInstanceOf(MemoryRateLimitStore)
  })

  it('throws a clear error when redis is selected without credentials', async () => {
    vi.stubEnv('RATE_LIMIT_STORE', 'redis')
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '')
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '')
    await expect(getRateLimitStore()).rejects.toThrow(/UPSTASH_REDIS_REST_URL/)
  })
})

describe('isKycRateLimitBypassed', () => {
  it('returns false for unknown user', () => {
    expect(isKycRateLimitBypassed('unknown-id')).toBe(false)
  })
})

describe('KYC limiter configurations', () => {
  it('kycSubmitHourly allows 3 then blocks', async () => {
    const id = `hourly-test-${Date.now()}-${Math.random()}`
    expect((await kycSubmitHourly.check(id)).allowed).toBe(true)
    expect((await kycSubmitHourly.check(id)).allowed).toBe(true)
    expect((await kycSubmitHourly.check(id)).allowed).toBe(true)
    expect((await kycSubmitHourly.check(id)).allowed).toBe(false)
    await kycSubmitHourly.reset(id)
  })

  it('kycSubmitDaily allows 10 then blocks', async () => {
    const id = `daily-test-${Date.now()}-${Math.random()}`
    for (let i = 0; i < 10; i++) {
      expect((await kycSubmitDaily.check(id)).allowed).toBe(true)
    }
    expect((await kycSubmitDaily.check(id)).allowed).toBe(false)
    await kycSubmitDaily.reset(id)
  })

  it('kycSubmitGlobal allows 100 per minute', async () => {
    const id = `global-test-${Date.now()}-${Math.random()}`
    for (let i = 0; i < 100; i++) {
      expect((await kycSubmitGlobal.check(id)).allowed).toBe(true)
    }
    expect((await kycSubmitGlobal.check(id)).allowed).toBe(false)
    await kycSubmitGlobal.reset(id)
  })

  it('kycStatusLimiter allows 30 per minute', async () => {
    const id = `status-test-${Date.now()}-${Math.random()}`
    for (let i = 0; i < 30; i++) {
      expect((await kycStatusLimiter.check(id)).allowed).toBe(true)
    }
    expect((await kycStatusLimiter.check(id)).allowed).toBe(false)
    await kycStatusLimiter.reset(id)
  })
})
