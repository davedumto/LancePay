import { NextResponse, type NextRequest } from 'next/server'

type RateLimitPolicy = {
  id: string
  pathPrefixes: string[]
  methods: string[]
  maxRequests: number
  windowMs: number
  /** Stricter limit applied to requests with no client IP identifier. */
  anonymousMaxRequests: number
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

// ── RateLimitStore ──────────────────────────────────────────────────────────

export type ConsumeResult = {
  count: number
  resetAt: number
  /** false when the window was already exhausted and nothing was counted. */
  counted: boolean
}

/**
   * Storage backend for fixed-window counters.
   *
   * `consume` must be atomic: concurrent calls for the same key must not
   * overshoot `limit`. Implementations return the post-consume count and
   * window reset instant.
   */
export interface RateLimitStore {
  consume(key: string, limit: number, windowMs: number, now: number): Promise<ConsumeResult>
  peek(key: string, now: number): Promise<RateLimitEntry | null>
  delete(key: string): Promise<void>
}

const CLEANUP_THRESHOLD = 5000

/**
 * Default in-process store. Correct for local development and tests; on
 * serverless platforms each instance keeps its own map, so production
 * deployments should set RATE_LIMIT_STORE=redis (see .env.example).
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private entries = new Map<string, RateLimitEntry>()

  private cleanupExpired(now: number) {
    if (this.entries.size < CLEANUP_THRESHOLD) return
    for (const [key, value] of this.entries) {
      if (value.resetAt <= now) this.entries.delete(key)
    }
  }

  async consume(key: string, limit: number, windowMs: number, now: number): Promise<ConsumeResult> {
    this.cleanupExpired(now)
    const existing = this.entries.get(key)

    if (!existing || now >= existing.resetAt) {
      const resetAt = now + windowMs
      this.entries.set(key, { count: 1, resetAt })
      return { count: 1, resetAt, counted: true }
    }

    if (existing.count >= limit) {
      return { count: existing.count, resetAt: existing.resetAt, counted: false }
    }

    existing.count += 1
    this.entries.set(key, existing)
    return { count: existing.count, resetAt: existing.resetAt, counted: true }
  }

  async peek(key: string, now: number): Promise<RateLimitEntry | null> {
    const existing = this.entries.get(key)
    if (!existing || now >= existing.resetAt) return null
    return existing
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key)
  }
}

/** Minimal Redis-compatible client surface (ioredis / @upstash/redis). */
export interface RedisEvalClient {
  eval(script: string, keys: string[], args: Array<string | number>): Promise<unknown>
}

/**
 * Lua script implementing the same fixed-window semantics as
 * MemoryRateLimitStore.consume: start a new window when missing/expired,
 * count the request while under the limit, otherwise leave the counter
 * untouched. Executed atomically by Redis so concurrent requests cannot
 * overshoot the limit.
 */
const CONSUME_SCRIPT = `
local data = redis.call('HMGET', KEYS[1], 'count', 'resetAt')
local count = tonumber(data[1]) or 0
local resetAt = tonumber(data[2]) or 0
local limit = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local counted = 0
if resetAt <= now or count == 0 then
  resetAt = now + windowMs
  count = 1
  counted = 1
elseif count < limit then
  count = count + 1
  counted = 1
end
redis.call('HMSET', KEYS[1], 'count', count, 'resetAt', resetAt)
redis.call('PEXPIRE', KEYS[1], windowMs + 1000)
return { count, resetAt, counted }
`

const PEEK_SCRIPT = `
local data = redis.call('HMGET', KEYS[1], 'count', 'resetAt')
local count = tonumber(data[1]) or 0
local resetAt = tonumber(data[2]) or 0
local now = tonumber(ARGV[1])
if resetAt <= now or count == 0 then
  return nil
end
return { count, resetAt }
`

/**
 * Redis-backed store. Counters live in a shared Redis instance so limits
 * hold across serverless instances and cold starts.
 */
export class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly client: RedisEvalClient) {}

  async consume(key: string, limit: number, windowMs: number, now: number): Promise<ConsumeResult> {
    const raw = (await this.client.eval(CONSUME_SCRIPT, [key], [
      limit,
      windowMs,
      now,
    ])) as [number, number, number] | null
    if (!raw) {
      // Defensive fallback; the script always returns a triple.
      return { count: limit, resetAt: now + windowMs, counted: false }
    }
    const [count, resetAt, counted] = raw
    return { count: Number(count), resetAt: Number(resetAt), counted: Number(counted) === 1 }
  }

  async peek(key: string, now: number): Promise<RateLimitEntry | null> {
    const raw = (await this.client.eval(PEEK_SCRIPT, [key], [now])) as
      | [number, number]
      | null
    if (!raw) return null
    const [count, resetAt] = raw
    return { count: Number(count), resetAt: Number(resetAt) }
  }

  async delete(key: string): Promise<void> {
    await this.client.eval(`return redis.call('DEL', KEYS[1])`, [key], [])
  }
}

const globalStore = globalThis as typeof globalThis & {
  __lancepayRateLimitMemoryStore?: MemoryRateLimitStore
  __lancepayRateLimitStorePromise?: Promise<RateLimitStore>
}

function memoryStore(): MemoryRateLimitStore {
  if (!globalStore.__lancepayRateLimitMemoryStore) {
    globalStore.__lancepayRateLimitMemoryStore = new MemoryRateLimitStore()
  }
  return globalStore.__lancepayRateLimitMemoryStore
}

async function createStore(): Promise<RateLimitStore> {
  const kind = (process.env.RATE_LIMIT_STORE || 'memory').trim().toLowerCase()
  if (kind === 'redis' || kind === 'upstash') {
    const url = process.env.UPSTASH_REDIS_REST_URL
    const token = process.env.UPSTASH_REDIS_REST_TOKEN
    if (!url || !token) {
      throw new Error(
        'RATE_LIMIT_STORE=redis requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN',
      )
    }
    const { Redis } = await import('@upstash/redis')
    return new RedisRateLimitStore(new Redis({ url, token }))
  }
  return memoryStore()
}

/**
 * Resolve the active store once per process. Defaults to the in-memory
 * store; set RATE_LIMIT_STORE=redis with Upstash credentials for a shared
 * backend across serverless instances.
 */
export function getRateLimitStore(): Promise<RateLimitStore> {
  if (!globalStore.__lancepayRateLimitStorePromise) {
    globalStore.__lancepayRateLimitStorePromise = createStore()
  }
  return globalStore.__lancepayRateLimitStorePromise
}

/** Test hook: reset the cached store selection. */
export function resetRateLimitStoreForTests(): void {
  globalStore.__lancepayRateLimitStorePromise = undefined
  globalStore.__lancepayRateLimitMemoryStore = undefined
}

const POLICIES: RateLimitPolicy[] = [
  {
    id: 'api-pay',
    pathPrefixes: ['/api/pay'],
    methods: ['GET', 'POST'],
    maxRequests: 60,
    windowMs: 60_000,
    anonymousMaxRequests: 10,
  },
  {
    id: 'api-auth',
    pathPrefixes: ['/api/auth'],
    methods: ['GET', 'POST'],
    maxRequests: 30,
    windowMs: 60_000,
    anonymousMaxRequests: 5,
  },
]

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

type ClientIdentifier = {
  /** Bucket key suffix — an IP when known, 'anonymous' otherwise. */
  identifier: string
  anonymous: boolean
}

/**
 * Resolve the client identifier for rate limiting.
 *
 * Checks the common platform-injected forwarding headers
 * (x-forwarded-for, x-real-ip, cf-connecting-ip, true-client-ip,
 * fastly-client-ip, x-client-ip, x-vercel-forwarded-for). When none is
 * present the request is marked `anonymous`: it is then limited by the
 * policy's stricter `anonymousMaxRequests` bucket (shared across all
 * headerless clients — a deliberate trade-off so unidentified traffic
 * cannot get unlimited requests) and the occurrence is logged once per
 * window.
 */
function getClientIdentifier(request: NextRequest): ClientIdentifier {
  const candidates = [
    'x-forwarded-for',
    'x-real-ip',
    'cf-connecting-ip',
    'true-client-ip',
    'fastly-client-ip',
    'x-client-ip',
    'x-vercel-forwarded-for',
  ]
  for (const header of candidates) {
    const value = request.headers.get(header)?.trim()
    if (!value) continue
    // For multi-value forwarding headers the left-most entry is the
    // client-supplied original sender.
    const first = value.split(',')[0]?.trim()
    if (first) return { identifier: first, anonymous: false }
  }
  return { identifier: 'anonymous', anonymous: true }
}

// Tracks the last window in which each policy logged an anonymous request,
// so the occurrence is logged once per window rather than per request.
const anonymousLoggedWindows = new Map<string, number>()

function logAnonymousRateLimitOnce(policy: RateLimitPolicy, resetAt: number) {
  if (anonymousLoggedWindows.get(policy.id) === resetAt) return
  anonymousLoggedWindows.set(policy.id, resetAt)
  console.warn(
    `[rate-limit] ${policy.id}: request without client IP headers applied to ` +
      `stricter anonymous bucket (${policy.anonymousMaxRequests}/${Math.round(policy.windowMs / 1000)}s)`,
  )
}

/**
 * Route-level rate limiter for use inside API handlers.
 * Supports composite keys (e.g. IP + userId) and manual reset.
 * Shares the same store as middleware-level rate limiting.
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

  async check(identifier: string): Promise<RequestRateLimitResult> {
    const store = await getRateLimitStore()
    const result = await store.consume(
      `${this.policyId}:${identifier}`,
      this.maxRequests,
      this.windowMs,
      Date.now(),
    )
    return {
      policyId: this.policyId,
      allowed: result.counted,
      limit: this.maxRequests,
      remaining: Math.max(this.maxRequests - result.count, 0),
      resetAt: result.resetAt,
    }
  }

  async reset(identifier: string): Promise<void> {
    const store = await getRateLimitStore()
    await store.delete(`${this.policyId}:${identifier}`)
  }

  /**
   * Read the current state for an identifier without incrementing the counter.
   * Returns null when no entry exists (i.e. no requests have been made yet).
   */
  async peek(identifier: string): Promise<RequestRateLimitResult | null> {
    const store = await getRateLimitStore()
    const existing = await store.peek(`${this.policyId}:${identifier}`, Date.now())
    if (!existing) return null

    return {
      policyId: this.policyId,
      allowed: existing.count < this.maxRequests,
      limit: this.maxRequests,
      remaining: Math.max(this.maxRequests - existing.count, 0),
      resetAt: existing.resetAt,
    }
  }
}

export function getClientIp(request: NextRequest): string {
  return getClientIdentifier(request).identifier
}

/**
 * Returns the current rate-limit state for every middleware policy that
 * matches the given IP, without consuming any quota. Entries that have
 * never been hit or whose window has expired are omitted.
 */
export async function peekRateLimitStatus(ip: string): Promise<Array<{
  policyId: string
  limit: number
  remaining: number
  resetAt: number
  allowed: boolean
}>> {
  const store = await getRateLimitStore()
  const now = Date.now()
  return Promise.all(
    POLICIES.map(async (policy) => {
      const entry = await store.peek(`${policy.id}:${ip}`, now)
      if (!entry) {
        return {
          policyId: policy.id,
          limit: policy.maxRequests,
          remaining: policy.maxRequests,
          resetAt: 0,
          allowed: true,
        }
      }
      return {
        policyId: policy.id,
        limit: policy.maxRequests,
        remaining: Math.max(policy.maxRequests - entry.count, 0),
        resetAt: entry.resetAt,
        allowed: entry.count < policy.maxRequests,
      }
    }),
  )
}

export async function checkRequestRateLimit(request: NextRequest): Promise<RequestRateLimitResult | null> {
  const policy = findPolicy(request.nextUrl.pathname, request.method)
  if (!policy) return null

  const { identifier, anonymous } = getClientIdentifier(request)
  const limit = anonymous ? policy.anonymousMaxRequests : policy.maxRequests
  const store = await getRateLimitStore()
  const result = await store.consume(
    `${policy.id}:${identifier}`,
    limit,
    policy.windowMs,
    Date.now(),
  )

  if (anonymous) {
    logAnonymousRateLimitOnce(policy, result.resetAt)
  }

  return {
    policyId: policy.id,
    allowed: result.counted,
    limit,
    remaining: Math.max(limit - result.count, 0),
    resetAt: result.resetAt,
  }
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
