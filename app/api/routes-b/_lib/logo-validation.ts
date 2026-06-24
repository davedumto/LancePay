import { getCacheValue, setCacheValue } from './cache'

const LOGO_CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour
const LOGO_FETCH_TIMEOUT_MS = 3000

type LogoCheckResult =
  | { ok: true }
  | { ok: false; error: string }

function cacheKey(url: string): string {
  return `routes-b:logo-check:${url}`
}

export async function validateLogoUrl(url: string): Promise<LogoCheckResult> {
  const cached = getCacheValue<LogoCheckResult>(cacheKey(url))
  if (cached) {
    return cached
  }

  let result: LogoCheckResult

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), LOGO_FETCH_TIMEOUT_MS)

    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
    })

    clearTimeout(timeout)

    if (!response.ok) {
      result = { ok: false, error: `URL returned ${response.status}` }
    } else {
      const contentType = response.headers.get('content-type') ?? ''
      if (!contentType.startsWith('image/')) {
        result = { ok: false, error: `URL does not serve an image (Content-Type: ${contentType})` }
      } else {
        result = { ok: true }
      }
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      result = { ok: false, error: 'URL request timed out after 3s' }
    } else {
      result = { ok: false, error: 'URL is unreachable' }
    }
  }

  setCacheValue(cacheKey(url), result, LOGO_CACHE_TTL_MS)
  return result
}
