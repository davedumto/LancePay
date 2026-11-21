import { NextResponse, type NextRequest } from 'next/server'
import { resolveClientIp } from '@/lib/client-ip'

type RateLimitEntry = {
  count: number
  resetAt: number
}

export type RequestRateLimitResult = {
  policyId: string
  allowed: boolean
  limit: number
  remaining: number
  resetAt: number
}

type MiddlewarePolicy = {
  id: string
  limit: number
  pathPrefixes: string[]
  methods: string[]
  limiter: RouteRateLimiter
}

const globalStore = globalThis as typeof globalThis & {
  __lancepayRateLimitStore?: Map<string, RateLimitEntry>
}

const STORE = globalStore.__lancepayRateLimitStore ?? new Map<string, RateLimitEntry>()
if (!globalStore.__lancepayRateLimitStore) {
  globalStore.__lancepayRateLimitStore = STORE
}

function cleanupExpiredEntries(now: number) {
  if (STORE.size < 5000) return
  for (const [key, value] of STORE.entries()) {
    if (value.resetAt <= now) {
      STORE.delete(key)
    }
  }
}

/**
 * Single window-consume implementation shared by the middleware policies and
 * RouteRateLimiter. Creates a new window when none exists or the previous one
 * expired, rejects once `limit` requests were seen, otherwise increments.
 */
function consumeWindow(
  key: string,
  policyId: string,
  limit: number,
  windowMs: number,
  now: number,
): RequestRateLimitResult {
  cleanupExpiredEntries(now)

  const existing = STORE.get(key)

  if (!existing || now >= existing.resetAt) {
    const resetAt = now + windowMs
    STORE.set(key, { count: 1, resetAt })
    return {
      policyId,
      allowed: true,
      limit,
      remaining: limit - 1,
      resetAt,
    }
  }

  if (existing.count >= limit) {
    return {
      policyId,
      allowed: false,
      limit,
      remaining: 0,
      resetAt: existing.resetAt,
    }
  }

  existing.count += 1
  STORE.set(key, existing)

  return {
    policyId,
    allowed: true,
    limit,
    remaining: Math.max(limit - existing.count, 0),
    resetAt: existing.resetAt,
  }
}

/**
 * Single window-peek implementation shared by RouteRateLimiter.peek and
 * peekRateLimitStatus. Returns the live entry or null when the window has not
 * started or has expired.
 */
function peekWindow(key: string, now: number): RateLimitEntry | null {
  const existing = STORE.get(key)
  if (!existing || now >= existing.resetAt) return null
  return existing
}

/**
 * Route-level rate limiter for use inside API handlers.
 * Supports composite keys (e.g. IP + userId) and manual reset.
 * Shares the same global store as middleware-level rate limiting.
 */
export class RouteRateLimiter {
  private maxRequests: number
  private windowMs: number
  private policyId: string

  constructor(opts: { id: string; maxRequests: number; windowMs: number }) {
    this.policyId = opts.id
    this.maxRequests = opts.maxRequests
    this.windowMs = opts.windowMs
  }

  check(identifier: string): RequestRateLimitResult {
    const now = Date.now()
    return consumeWindow(
      `${this.policyId}:${identifier}`,
      this.policyId,
      this.maxRequests,
      this.windowMs,
      now,
    )
  }

  reset(identifier: string): void {
    STORE.delete(`${this.policyId}:${identifier}`)
  }

  /**
   * Read the current state for an identifier without incrementing the counter.
   * Returns null when no entry exists (i.e. no requests have been made yet).
   */
  peek(identifier: string): RequestRateLimitResult | null {
    const now = Date.now()
    const existing = peekWindow(`${this.policyId}:${identifier}`, now)
    if (!existing) return null

    const remaining = Math.max(this.maxRequests - existing.count, 0)
    return {
      policyId: this.policyId,
      allowed: existing.count < this.maxRequests,
      limit: this.maxRequests,
      remaining,
      resetAt: existing.resetAt,
    }
  }
}

export function getClientIp(request: NextRequest): string {
  return resolveClientIp(request.headers)
}

// Middleware policies are plain RouteRateLimiter instances; the descriptors
// below only add path/method matching on top of the shared limiter.
const POLICIES: MiddlewarePolicy[] = [
  {
    id: 'api-pay',
    limit: 60,
    pathPrefixes: ['/api/pay'],
    methods: ['GET', 'POST'],
    limiter: new RouteRateLimiter({ id: 'api-pay', maxRequests: 60, windowMs: 60_000 }),
  },
  {
    id: 'api-auth',
    limit: 30,
    pathPrefixes: ['/api/auth'],
    methods: ['GET', 'POST'],
    limiter: new RouteRateLimiter({ id: 'api-auth', maxRequests: 30, windowMs: 60_000 }),
  },
]

function findPolicy(pathname: string, method: string): MiddlewarePolicy | null {
  const upperMethod = method.toUpperCase()
  for (const policy of POLICIES) {
    if (!policy.methods.includes(upperMethod)) continue
    if (policy.pathPrefixes.some((prefix) => pathname.startsWith(prefix))) {
      return policy
    }
  }
  return null
}

/**
 * Returns the current rate-limit state for every middleware policy that
 * matches the given IP, without consuming any quota. Policies with no live
 * window report as fully available.
 */
export function peekRateLimitStatus(ip: string): Array<{
  policyId: string
  limit: number
  remaining: number
  resetAt: number
  allowed: boolean
}> {
  return POLICIES.map((policy) => {
    const peeked = policy.limiter.peek(ip)
    if (!peeked) {
      // Window not started or already expired — report as fully available
      return {
        policyId: policy.id,
        limit: policy.limit,
        remaining: policy.limit,
        resetAt: 0,
        allowed: true,
      }
    }
    return peeked
  })
}

export function checkRequestRateLimit(request: NextRequest): RequestRateLimitResult | null {
  const policy = findPolicy(request.nextUrl.pathname, request.method)
  if (!policy) return null

  return policy.limiter.check(getClientIp(request))
}

/**
 * Shared 429 response body. `resetAt` is an ISO-8601 timestamp; the matching
 * `X-RateLimit-Reset` header carries the same instant in epoch seconds.
 */
export function rateLimitExceededBody(result: RequestRateLimitResult) {
  return {
    error: 'Rate limit exceeded. Please try again later.',
    limit: result.limit,
    remaining: result.remaining,
    resetAt: new Date(result.resetAt).toISOString(),
  }
}

/**
 * Shared rate-limit response headers. `X-RateLimit-Reset` is always epoch
 * SECONDS (same unit convention as `Retry-After`), never milliseconds.
 */
export function rateLimitHeaders(result: RequestRateLimitResult): Record<string, string> {
  const retryAfterSeconds = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000))
  return {
    'X-RateLimit-Limit': result.limit.toString(),
    'X-RateLimit-Remaining': result.remaining.toString(),
    'X-RateLimit-Reset': Math.floor(result.resetAt / 1000).toString(),
    'X-RateLimit-Policy': result.policyId,
    'Retry-After': retryAfterSeconds.toString(),
  }
}

export function buildRateLimitResponse(result: RequestRateLimitResult): NextResponse {
  return NextResponse.json(rateLimitExceededBody(result), {
    status: 429,
    headers: rateLimitHeaders(result),
  })
}

export const twoFactorLimiter = new RouteRateLimiter({
  id: '2fa-verify',
  maxRequests: 5,
  windowMs: 15 * 60_000,
})

// ── KYC-specific limiters ────────────────────────────────────────────────────

/** Per-user: max 3 KYC submissions per hour (prevents rapid-fire resubmits). */
export const kycSubmitHourly = new RouteRateLimiter({
  id: 'kyc-submit-hourly',
  maxRequests: 3,
  windowMs: 60 * 60_000,
})

/** Per-user: max 10 KYC submissions per day. */
export const kycSubmitDaily = new RouteRateLimiter({
  id: 'kyc-submit-daily',
  maxRequests: 10,
  windowMs: 24 * 60 * 60_000,
})

/** Global (all users): max 100 KYC submissions per minute. */
export const kycSubmitGlobal = new RouteRateLimiter({
  id: 'kyc-submit-global',
  maxRequests: 100,
  windowMs: 60_000,
})

/** Per-user: max 30 KYC status checks per minute. */
export const kycStatusLimiter = new RouteRateLimiter({
  id: 'kyc-status',
  maxRequests: 30,
  windowMs: 60_000,
})

/**
 * Allowlist of user IDs that bypass KYC rate limits (e.g. internal test
 * accounts or support tooling). Loaded from the KYC_RATE_LIMIT_BYPASS_IDS
 * environment variable as a comma-separated list.
 */
const KYC_BYPASS_IDS: Set<string> = new Set(
  (process.env.KYC_RATE_LIMIT_BYPASS_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
)

export function isKycRateLimitBypassed(userId: string): boolean {
  return KYC_BYPASS_IDS.has(userId)
}
