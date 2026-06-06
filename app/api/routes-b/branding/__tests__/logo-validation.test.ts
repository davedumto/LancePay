import { describe, it, expect, beforeEach, vi } from 'vitest'
import { validateLogoUrl } from '../../_lib/logo-validation'
import { clearCache } from '../../_lib/cache'

describe('validateLogoUrl', () => {
  beforeEach(() => {
    clearCache()
    vi.restoreAllMocks()
  })

  it('returns ok for reachable image URL', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(null, {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }),
    )

    const result = await validateLogoUrl('https://example.com/logo.png')
    expect(result.ok).toBe(true)
  })

  it('returns error for non-image content-type', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(null, {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    )

    const result = await validateLogoUrl('https://example.com/page.html')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('does not serve an image')
    }
  })

  it('returns error on timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => {
      return new Promise((_, reject) => {
        setTimeout(() => {
          const err = new Error('The operation was aborted')
          err.name = 'AbortError'
          reject(err)
        }, 100)
      })
    })

    const result = await validateLogoUrl('https://example.com/slow.png')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('timed out')
    }
  })

  it('returns error on 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(null, { status: 404 }),
    )

    const result = await validateLogoUrl('https://example.com/missing.png')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('404')
    }
  })

  it('caches successful check and skips subsequent fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(null, {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }),
    )

    const url = 'https://example.com/cached-logo.png'
    await validateLogoUrl(url)
    await validateLogoUrl(url)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('caches failed check and skips subsequent fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(null, { status: 404 }),
    )

    const url = 'https://example.com/missing.png'
    await validateLogoUrl(url)
    await validateLogoUrl(url)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})
