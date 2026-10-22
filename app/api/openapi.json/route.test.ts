import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET, buildOpenApiSpec, computeSpecHash } from './route'

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}))

describe('GET /api/openapi.json', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function makeRequest(url = 'http://localhost:3000/api/openapi.json', headers: Record<string, string> = {}) {
    return new NextRequest(url, {
      method: 'GET',
      headers,
    })
  }

  it('serves OpenAPI 3.1 document composed dynamically from route metadata', async () => {
    const req = makeRequest()
    const res = await GET(req)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.openapi).toBe('3.1.0')
    expect(json.info.title).toBe('LancePay Public API')
    expect(json.paths['/api/invoices']).toBeDefined()
    expect(json.paths['/api/withdrawals']).toBeDefined()
    expect(json.paths['/api/stellar/trustlines/usdc/bootstrap']).toBeDefined()

    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.headers.get('cache-control')).toContain('public')
    expect(res.headers.get('etag')).toBeDefined()
  })

  it('honors version query parameter and filters older versions', async () => {
    const req = makeRequest('http://localhost:3000/api/openapi.json?version=2026-10-01')
    const res = await GET(req)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.info.version).toBe('2026-10-01')
    expect(json.paths['/api/invoices']).toBeDefined()
    // Routes introduced in 2026-10-18 should not be in 2026-10-01
    expect(json.paths['/api/stellar/trustlines/usdc/bootstrap']).toBeUndefined()
  })

  it('returns 304 Not Modified when client provides matching If-None-Match ETag', async () => {
    const spec = buildOpenApiSpec('2026-10-18')
    const hash = computeSpecHash(spec)

    const req = makeRequest('http://localhost:3000/api/openapi.json', {
      'if-none-match': `"${hash}"`,
    })

    const res = await GET(req)
    expect(res.status).toBe(304)
    expect(res.headers.get('etag')).toBe(`"${hash}"`)
  })

  it('sets cache headers tied to build-time spec hash', async () => {
    const req = makeRequest()
    const res = await GET(req)

    expect(res.headers.get('cache-control')).toBe('public, max-age=86400, stale-while-revalidate=3600')
    expect(res.headers.get('etag')).toMatch(/^"[a-f0-9]{64}"$/)
  })
})
