type Bucket = {
  tokens: number;
  resetAt: number;
};

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfter: number };

const buckets = new Map<string, Bucket>();

/**
 * Check if a request is allowed under rate limit.
 *
 * Time Complexity: O(1) - Map lookup and update
 * Space Complexity: O(1) - Single bucket entry
 *
 * Uses token bucket algorithm with fixed window.
 * Returns allowed=true if within limit, false with retryAfter if exceeded.
 */
export function checkRateLimit(
  key: string,
  options: { limit: number; windowMs: number },
  now = Date.now(),
): RateLimitResult {
  const existing = buckets.get(key);

  if (!existing || now >= existing.resetAt) {
    buckets.set(key, {
      tokens: options.limit - 1,
      resetAt: now + options.windowMs,
    });
    return { allowed: true };
  }

  if (existing.tokens <= 0) {
    return {
      allowed: false,
      retryAfter: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  existing.tokens -= 1;
  return { allowed: true };
}

/**
 * Reset all rate limit buckets (for testing).
 *
 * Time Complexity: O(n) where n is number of active buckets
 * Space Complexity: O(1) - No additional space
 */
export function resetRateLimitBuckets() {
  buckets.clear();
}

/**
 * Async wrapper for rate limiting.
 *
 * Time Complexity: O(1) - Delegates to checkRateLimit
 * Space Complexity: O(1) - No additional space
 */
export async function rateLimit(key: string, limit: number, windowMs: number) {
  const result = checkRateLimit(key, { limit, windowMs });

  return result.allowed
    ? { allowed: true as const }
    : {
        allowed: false as const,
        resetTime: new Date(
          Date.now() + result.retryAfter * 1000,
        ).toISOString(),
      };
}
