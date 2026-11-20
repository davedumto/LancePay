import { describe, it, expect, afterEach, vi } from 'vitest'
import { resolveClientIp } from '@/lib/client-ip'

function headers(entries: Record<string, string>): Headers {
  return new Headers(entries)
}

describe('resolveClientIp', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('prefers the platform-provided x-real-ip header', () => {
    const h = headers({
      'x-real-ip': '203.0.113.10',
      'x-forwarded-for': '198.51.100.1, 10.0.0.1',
    })
    expect(resolveClientIp(h)).toBe('203.0.113.10')
  })

  it('uses cf-connecting-ip when x-real-ip is absent', () => {
    const h = headers({
      'cf-connecting-ip': '203.0.113.20',
      'x-forwarded-for': '198.51.100.1',
    })
    expect(resolveClientIp(h)).toBe('203.0.113.20')
  })

  it('ignores a spoofed left-most x-forwarded-for hop', () => {
    // Client claims 1.2.3.4 but the trusted proxy appended the real peer.
    const h = headers({ 'x-forwarded-for': '1.2.3.4, 198.51.100.9' })
    expect(resolveClientIp(h)).toBe('198.51.100.9')
  })

  it('handles a single trusted hop', () => {
    const h = headers({ 'x-forwarded-for': '203.0.113.50' })
    expect(resolveClientIp(h)).toBe('203.0.113.50')
  })

  it('honours TRUSTED_PROXY_HOPS for multi-proxy deployments', () => {
    vi.stubEnv('TRUSTED_PROXY_HOPS', '2')
    // Two trusted proxies: the right-most entry is the inner proxy's peer
    // record; the client sits two hops from the right, left of any spoofed
    // prefix the client injected.
    const h = headers({ 'x-forwarded-for': '9.9.9.9, 203.0.113.77, 10.0.0.2' })
    expect(resolveClientIp(h)).toBe('203.0.113.77')
  })

  it('returns anonymous when no IP headers are present', () => {
    expect(resolveClientIp(headers({}))).toBe('anonymous')
  })

  it('returns anonymous for an empty x-forwarded-for', () => {
    expect(resolveClientIp(headers({ 'x-forwarded-for': ' , ' }))).toBe('anonymous')
  })
})
