import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}))

import {
  GET,
  DEFAULT_OPENAPI_VERSION,
  OPENAPI_CACHE_CONTROL,
} from './route'

function makeRequest(query = '', headers: Record<string, string> = {}): NextRequest {
  const suffix = query ? `?${query}` : ''
  return new NextRequest(`http://localhost/api/openapi.json${suffix}`, {
    method: 'GET',
    headers,
  })
}

describe('GET /api/openapi.json (#1572)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('serves the OpenAPI 3.1.0 document for the default API version with deterministic ETag and Cache-Control headers', async () => {
    const res = await GET(makeRequest())

    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe(OPENAPI_CACHE_CONTROL)
    expect(res.headers.get('X-OpenAPI-Version')).toBe(DEFAULT_OPENAPI_VERSION)
    const etag = res.headers.get('ETag')
    expect(etag).toMatch(/^"sha256-[0-9a-f]{32}"$/)

    const spec = await res.json()
    expect(spec.openapi).toBe('3.1.0')
    expect(spec.info.version).toBe('2026-06-01')
    expect(spec.paths['/api/invoices']).toBeDefined()
    expect(spec.paths['/api/developer-portal/sandbox-sessions']).toBeDefined()
    expect(spec.paths['/api/api-versions']).toBeDefined()
    expect(spec.components.securitySchemes.BearerAuth).toBeDefined()
  })

  it('honors the ?version= query parameter and scopes routes to that API version', async () => {
    const res202505 = await GET(makeRequest('version=2025-05-01'))
    expect(res202505.status).toBe(200)
    expect(res202505.headers.get('X-OpenAPI-Version')).toBe('2025-05-01')

    const spec202505 = await res202505.json()
    expect(spec202505.info.version).toBe('2025-05-01')
    expect(spec202505.paths['/api/invoices']).toBeDefined()
    // Sandbox sessions were introduced in 2026-06-01, so they should not appear in 2025-05-01
    expect(spec202505.paths['/api/developer-portal/sandbox-sessions']).toBeUndefined()

    const defaultRes = await GET(makeRequest('version=2026-06-01'))
    expect(res202505.headers.get('ETag')).not.toBe(defaultRes.headers.get('ETag'))
  })

  it('returns 304 Not Modified when If-None-Match matches the current ETag (strong or weak)', async () => {
    const first = await GET(makeRequest('version=2026-06-01'))
    const etag = first.headers.get('ETag')!

    const second = await GET(makeRequest('version=2026-06-01', { 'if-none-match': etag }))
    expect(second.status).toBe(304)
    expect(second.headers.get('ETag')).toBe(etag)
    expect(second.headers.get('Cache-Control')).toBe(OPENAPI_CACHE_CONTROL)
    expect(await second.text()).toBe('')

    const weakMatch = await GET(
      makeRequest('version=2026-06-01', { 'if-none-match': `W/${etag}` })
    )
    expect(weakMatch.status).toBe(304)
  })

  it('returns 400 for malformed version strings and 404 for unsupported/sunset versions', async () => {
    const malformed = await GET(makeRequest('version=v99-bad'))
    expect(malformed.status).toBe(400)
    expect((await malformed.json()).code).toBe('INVALID_API_VERSION_FORMAT')

    const unsupported = await GET(makeRequest('version=2024-10-01'))
    expect(unsupported.status).toBe(404)
    const errBody = await unsupported.json()
    expect(errBody.code).toBe('UNSUPPORTED_API_VERSION')
    expect(errBody.supportedVersions).toContain('2026-06-01')
  })
})
