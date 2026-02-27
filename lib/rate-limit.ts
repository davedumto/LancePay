import { NextResponse, type NextRequest } from 'next/server'

type RateLimitPolicy = {
  id: string
  pathPrefixes: string[]
  methods: string[]
  maxRequests: number
  windowMs: number
}

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

const POLICIES: RateLimitPolicy[] = [
  {
    id: 'api-pay',
    pathPrefixes: ['/api/pay'],
    methods: ['GET', 'POST'],
    maxRequests: 60,
    windowMs: 60_000,
  },
  {
    id: 'api-auth',
    pathPrefixes: ['/api/auth', '/api/sep24/auth'],
    methods: ['GET', 'POST'],
    maxRequests: 30,
    windowMs: 60_000,
  },
]

const globalStore = globalThis as typeof globalThis & {
  __lancepayRateLimitStore?: Map<string, RateLimitEntry>
}

const STORE = globalStore.__lancepayRateLimitStore ?? new Map<string, RateLimitEntry>()
if (!globalStore.__lancepayRateLimitStore) {
  globalStore.__lancepayRateLimitStore = STORE
}

function findPolicy(pathname: string, method: string): RateLimitPolicy | null {
  const upperMethod = method.toUpperCase()
  for (const policy of POLICIES) {
    if (!policy.methods.includes(upperMethod)) continue
    if (policy.pathPrefixes.some((prefix) => pathname.startsWith(prefix))) {
      return policy
    }
  }
  return null
}

function getClientIdentifier(request: NextRequest): string {
  const forwardedFor = request.headers.get('x-forwarded-for')
  if (forwardedFor) {
    const ip = forwardedFor.split(',')[0]?.trim()
    if (ip) return ip
  }

  const realIp = request.headers.get('x-real-ip')?.trim()
  if (realIp) return realIp

  const cfIp = request.headers.get('cf-connecting-ip')?.trim()
  if (cfIp) return cfIp

  return 'anonymous'
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
    cleanupExpiredEntries(now)

    const key = `${this.policyId}:${identifier}`
    const existing = STORE.get(key)

    if (!existing || now >= existing.resetAt) {
      const resetAt = now + this.windowMs
      STORE.set(key, { count: 1, resetAt })
      return {
        policyId: this.policyId,
        allowed: true,
        limit: this.maxRequests,
        remaining: this.maxRequests - 1,
        resetAt,
      }
    }

    if (existing.count >= this.maxRequests) {
      return {
        policyId: this.policyId,
        allowed: false,
        limit: this.maxRequests,
        remaining: 0,
        resetAt: existing.resetAt,
      }
    }

    existing.count += 1
    STORE.set(key, existing)

    return {
      policyId: this.policyId,
      allowed: true,
      limit: this.maxRequests,
      remaining: Math.max(this.maxRequests - existing.count, 0),
      resetAt: existing.resetAt,
    }
  }

  reset(identifier: string): void {
    STORE.delete(`${this.policyId}:${identifier}`)
  }
}

export function getClientIp(request: NextRequest): string {
  return getClientIdentifier(request)
}

export function checkRequestRateLimit(request: NextRequest): RequestRateLimitResult | null {
  const policy = findPolicy(request.nextUrl.pathname, request.method)
  if (!policy) return null

  const now = Date.now()
  cleanupExpiredEntries(now)

  const identifier = getClientIdentifier(request)
  const key = `${policy.id}:${identifier}`
  const existing = STORE.get(key)

  if (!existing || now >= existing.resetAt) {
    const resetAt = now + policy.windowMs
    STORE.set(key, { count: 1, resetAt })
    return {
      policyId: policy.id,
      allowed: true,
      limit: policy.maxRequests,
      remaining: policy.maxRequests - 1,
      resetAt,
    }
  }

  if (existing.count >= policy.maxRequests) {
    return {
      policyId: policy.id,
      allowed: false,
      limit: policy.maxRequests,
      remaining: 0,
      resetAt: existing.resetAt,
    }
  }

  existing.count += 1
  STORE.set(key, existing)

  return {
    policyId: policy.id,
    allowed: true,
    limit: policy.maxRequests,
    remaining: Math.max(policy.maxRequests - existing.count, 0),
    resetAt: existing.resetAt,
  }
}

// ---------------------------------------------------------------------------
// KYC-specific rate limiters
// ---------------------------------------------------------------------------

export const kycSubmitHourly = new RouteRateLimiter({
  id: 'kyc-submit-hourly',
  maxRequests: 3,
  windowMs: 60 * 60_000,
})

export const kycSubmitDaily = new RouteRateLimiter({
  id: 'kyc-submit-daily',
  maxRequests: 10,
  windowMs: 24 * 60 * 60_000,
})

export const kycSubmitGlobal = new RouteRateLimiter({
  id: 'kyc-submit-global',
  maxRequests: 100,
  windowMs: 60_000,
})

export const kycStatusLimiter = new RouteRateLimiter({
  id: 'kyc-status',
  maxRequests: 30,
  windowMs: 60_000,
})

export const twoFactorLimiter = new RouteRateLimiter({
  id: '2fa-verify',
  maxRequests: 5,
  windowMs: 15 * 60_000, // 5 attempts per 15 minutes
})

const KYC_BYPASS_IDS: Set<string> = new Set(
  (process.env.KYC_RATE_LIMIT_BYPASS_USER_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
)

export function isKycRateLimitBypassed(userId: string): boolean {
  return KYC_BYPASS_IDS.has(userId)
}

export function buildRateLimitResponse(result: RequestRateLimitResult): NextResponse {
  const retryAfterSeconds = Math.ceil((result.resetAt - Date.now()) / 1000)
  return NextResponse.json(
    {
      error: 'Rate limit exceeded. Please try again later.',
      limit: result.limit,
      remaining: result.remaining,
      resetAt: new Date(result.resetAt).toISOString(),
    },
    {
      status: 429,
      headers: {
        'X-RateLimit-Limit': result.limit.toString(),
        'X-RateLimit-Remaining': result.remaining.toString(),
        'X-RateLimit-Reset': result.resetAt.toString(),
        'Retry-After': Math.max(retryAfterSeconds, 1).toString(),
      },
    }
  )
}
