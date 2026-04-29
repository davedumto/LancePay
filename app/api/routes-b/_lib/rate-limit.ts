type Bucket = {
  tokens: number
  resetAt: number
}

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfter: number }

const buckets = new Map<string, Bucket>()

export function checkRateLimit(
  key: string,
  options: { limit: number; windowMs: number },
  now = Date.now(),
): RateLimitResult {
  const existing = buckets.get(key)

  if (!existing || now >= existing.resetAt) {
    buckets.set(key, {
      tokens: options.limit - 1,
      resetAt: now + options.windowMs,
    })
    return { allowed: true }
  }

  if (existing.tokens <= 0) {
    return {
      allowed: false,
      retryAfter: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    }
  }

  existing.tokens -= 1
  return { allowed: true }
}

export function resetRateLimitBuckets() {
  buckets.clear()
}
