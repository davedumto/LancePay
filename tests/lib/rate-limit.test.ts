import { describe, it, expect, beforeEach } from 'vitest'
import {
  RouteRateLimiter,
  buildRateLimitResponse,
  isKycRateLimitBypassed,
  kycSubmitHourly,
  kycSubmitDaily,
  kycSubmitGlobal,
  kycStatusLimiter,
} from '@/lib/rate-limit'

describe('RouteRateLimiter', () => {
  let limiter: RouteRateLimiter

  beforeEach(() => {
    limiter = new RouteRateLimiter({ id: `test-${Date.now()}`, maxRequests: 3, windowMs: 60_000 })
  })

  it('allows requests under the limit', () => {
    const r1 = limiter.check('user-1')
    expect(r1.allowed).toBe(true)
    expect(r1.limit).toBe(3)
    expect(r1.remaining).toBe(2)
  })

  it('blocks after limit is reached', () => {
    limiter.check('user-1')
    limiter.check('user-1')
    limiter.check('user-1')
    const r4 = limiter.check('user-1')
    expect(r4.allowed).toBe(false)
    expect(r4.remaining).toBe(0)
  })

  it('limits are per-identifier (no cross-contamination)', () => {
    limiter.check('user-1')
    limiter.check('user-1')
    limiter.check('user-1')
    const r = limiter.check('user-2')
    expect(r.allowed).toBe(true)
  })

  it('resets counter after window expires', async () => {
    const fastLimiter = new RouteRateLimiter({ id: `fast-${Date.now()}`, maxRequests: 1, windowMs: 50 })
    fastLimiter.check('user-1')
    expect(fastLimiter.check('user-1').allowed).toBe(false)
    await new Promise((r) => setTimeout(r, 60))
    expect(fastLimiter.check('user-1').allowed).toBe(true)
  })

  it('reset() clears the counter for an identifier', () => {
    limiter.check('user-1')
    limiter.check('user-1')
    limiter.check('user-1')
    limiter.reset('user-1')
    expect(limiter.check('user-1').allowed).toBe(true)
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

describe('isKycRateLimitBypassed', () => {
  it('returns false for unknown user', () => {
    expect(isKycRateLimitBypassed('unknown-id')).toBe(false)
  })
})

describe('KYC limiter configurations', () => {
  it('kycSubmitHourly allows 3 then blocks', () => {
    const id = `hourly-test-${Date.now()}`
    expect(kycSubmitHourly.check(id).allowed).toBe(true)
    expect(kycSubmitHourly.check(id).allowed).toBe(true)
    expect(kycSubmitHourly.check(id).allowed).toBe(true)
    expect(kycSubmitHourly.check(id).allowed).toBe(false)
    kycSubmitHourly.reset(id)
  })

  it('kycSubmitDaily allows 10 then blocks', () => {
    const id = `daily-test-${Date.now()}`
    for (let i = 0; i < 10; i++) {
      expect(kycSubmitDaily.check(id).allowed).toBe(true)
    }
    expect(kycSubmitDaily.check(id).allowed).toBe(false)
    kycSubmitDaily.reset(id)
  })

  it('kycSubmitGlobal allows 100 per minute', () => {
    const id = `global-test-${Date.now()}`
    for (let i = 0; i < 100; i++) {
      expect(kycSubmitGlobal.check(id).allowed).toBe(true)
    }
    expect(kycSubmitGlobal.check(id).allowed).toBe(false)
    kycSubmitGlobal.reset(id)
  })

  it('kycStatusLimiter allows 30 per minute', () => {
    const id = `status-test-${Date.now()}`
    for (let i = 0; i < 30; i++) {
      expect(kycStatusLimiter.check(id).allowed).toBe(true)
    }
    expect(kycStatusLimiter.check(id).allowed).toBe(false)
    kycStatusLimiter.reset(id)
  })
})
