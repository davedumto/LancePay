/**
 * Shared client IP resolution for rate limiting and audit metadata.
 *
 * Trusted proxy assumption: the app runs behind a platform edge (Vercel or
 * Cloudflare) that sets `x-real-ip` / `cf-connecting-ip` / `x-vercel-forwarded-for`
 * itself, so those headers are preferred. `x-forwarded-for` is only used as a
 * fallback, and then the client IP is taken `TRUSTED_PROXY_HOPS` entries from
 * the right — hops supplied by the client on the left are ignored, so rotating
 * a spoofed left-most value no longer yields a fresh rate-limit bucket.
 *
 * Configure `TRUSTED_PROXY_HOPS` (default 1) to match the number of trusted
 * proxies that append to `x-forwarded-for` in your deployment.
 */

function trustedProxyHops(): number {
  const parsed = Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? '1', 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1
}

export function resolveClientIp(headers: Headers): string {
  // Platform-injected headers first — set by the edge, not by the client.
  const realIp = headers.get('x-real-ip')?.trim()
  if (realIp) return realIp

  const cfIp = headers.get('cf-connecting-ip')?.trim()
  if (cfIp) return cfIp

  const vercelForwarded = headers.get('x-vercel-forwarded-for')
  const forwardedFor = vercelForwarded ?? headers.get('x-forwarded-for')
  if (forwardedFor) {
    const hops = forwardedFor
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
    if (hops.length > 0) {
      // The right-most TRUSTED_PROXY_HOPS entries are trusted proxies; the
      // client is the entry immediately to their left.
      const index = Math.max(0, hops.length - trustedProxyHops())
      return hops[index]
    }
  }

  return 'anonymous'
}
