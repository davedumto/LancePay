import { describe, it, expect, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { middleware } from '@/middleware'
import {
  RouteRateLimiter,
  buildRateLimitResponse,
  checkRequestRateLimit,
  isKycRateLimitBypassed,
  kycSubmitHourly,
  kycSubmitDaily,
  kycSubmitGlobal,
  kycStatusLimiter,
  rateLimitExceededBody,
  rateLimitHeaders,
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
    expect(response.headers.get('X-RateLimit-Reset')).toBe(
      Math.floor(resetAt / 1000).toString(),
    )
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

describe('middleware / route-limiter parity', () => {
  function authRequest(ip: string) {
    return new NextRequest('http://localhost/api/auth/session', {
      headers: { 'x-real-ip': ip },
    })
  }

  it('produces identical results through both entry points', () => {
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`
    const routeLimiter = new RouteRateLimiter({
      id: 'api-auth',
      maxRequests: 30,
      windowMs: 60_000,
    })

    // Exhaust the api-auth window via the middleware entry point.
    let last: ReturnType<typeof checkRequestRateLimit> = null
    for (let i = 0; i < 30; i++) {
      last = checkRequestRateLimit(authRequest(ip))
      expect(last?.allowed).toBe(true)
    }

    // The route limiter sharing the same policy id sees the same window.
    const viaRoute = routeLimiter.check(ip)
    const viaMiddleware = checkRequestRateLimit(authRequest(ip))

    expect(viaRoute.allowed).toBe(false)
    expect(viaMiddleware?.allowed).toBe(false)
    expect(viaRoute.policyId).toBe(viaMiddleware?.policyId)
    expect(viaRoute.limit).toBe(viaMiddleware?.limit)
    expect(viaRoute.remaining).toBe(viaMiddleware?.remaining)
    expect(viaRoute.resetAt).toBe(viaMiddleware?.resetAt)
    routeLimiter.reset(ip)
  })

  it('middleware and route limiter emit the same 429 body shape and header units', async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`

    // Drive the middleware policy to exhaustion.
    let blocked: Response | null = null
    for (let i = 0; i < 31; i++) {
      const res = middleware(authRequest(ip))
      if (res.status === 429) {
        blocked = res
        break
      }
    }
    expect(blocked).not.toBeNull()

    const middlewareBody = await blocked!.json()
    const routeResponse = buildRateLimitResponse({
      policyId: 'api-auth',
      allowed: false,
      limit: 30,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    })
    const routeBody = await routeResponse.json()

    // Identical body shape.
    expect(Object.keys(middlewareBody).sort()).toEqual(Object.keys(routeBody).sort())
    expect(middlewareBody).toMatchObject({
      error: expect.any(String),
      limit: 30,
      remaining: 0,
      resetAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    })

    // X-RateLimit-Reset is epoch seconds (~10 digits), never milliseconds.
    const resetHeader = blocked!.headers.get('X-RateLimit-Reset')
    expect(resetHeader).toMatch(/^\d{10}$/)
    expect(Number(resetHeader)).toBeGreaterThan(1_000_000_000)
    expect(Number(resetHeader)).toBeLessThan(10_000_000_000)

    // Shared helpers agree with what the middleware emitted.
    const expected = rateLimitHeaders({
      policyId: 'api-auth',
      allowed: false,
      limit: 30,
      remaining: 0,
      resetAt: Number(resetHeader) * 1000,
    })
    expect(blocked!.headers.get('X-RateLimit-Limit')).toBe(expected['X-RateLimit-Limit'])
    expect(blocked!.headers.get('X-RateLimit-Policy')).toBe('api-auth')
    expect(Number(blocked!.headers.get('Retry-After'))).toBeGreaterThan(0)

    // Body produced by the shared helper matches the emitted shape.
    expect(rateLimitExceededBody({
      policyId: 'api-auth',
      allowed: false,
      limit: 30,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    })).toEqual({
      error: expect.any(String),
      limit: 30,
      remaining: 0,
      resetAt: expect.any(String),
    })

    new RouteRateLimiter({ id: 'api-auth', maxRequests: 30, windowMs: 60_000 }).reset(ip)
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
