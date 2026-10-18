import { describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import { GET } from './route'

function makeGetRequest(
  query = '',
  headers: Record<string, string> = {},
): NextRequest {
  const url = `http://localhost/api/graphql/schema${query ? `?${query}` : ''}`
  return new NextRequest(url, { method: 'GET', headers })
}

describe('GET /api/graphql/schema', () => {
  it('strips internal directives and admin-only fields/types before rendering the SDL string', async () => {
    const res = await GET(makeGetRequest('', { accept: 'text/plain' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/plain')

    const sdl = await res.text()

    // Public types and fields are present
    expect(sdl).toContain('type User {')
    expect(sdl).toContain('type Invoice {')
    expect(sdl).toContain('type CreditNote {')
    expect(sdl).toContain('createInvoice(')

    // Internal directives, internal fields, and admin-only fields/types are stripped
    expect(sdl).not.toContain('@internal')
    expect(sdl).not.toContain('@adminOnly')
    expect(sdl).not.toContain('@sqlTable')
    expect(sdl).not.toContain('twoFactorSecret')
    expect(sdl).not.toContain('internalRiskScore')
    expect(sdl).not.toContain('encryptedPayload')
    expect(sdl).not.toContain('adminOverrideNotes')
    expect(sdl).not.toContain('adminForceRefundOverride')
    expect(sdl).not.toContain('InternalAdminAuditRecord')
    expect(sdl).not.toContain('InternalSystemDiagnostics')
  })

  it('includes ETag and X-Schema-Hash headers and returns 304 Not Modified on matching If-None-Match', async () => {
    const firstRes = await GET(makeGetRequest())
    expect(firstRes.status).toBe(200)

    const etag = firstRes.headers.get('etag')
    const schemaHash = firstRes.headers.get('x-schema-hash')
    expect(etag).toMatch(/^"sha256-[0-9a-f]{64}"$/)
    expect(schemaHash).toMatch(/^[0-9a-f]{64}$/)

    // Strong ETag match -> 304
    const cachedStrong = await GET(
      makeGetRequest('', { 'if-none-match': etag! }),
    )
    expect(cachedStrong.status).toBe(304)
    expect(cachedStrong.headers.get('x-schema-hash')).toBe(schemaHash)

    // Weak ETag match -> 304
    const cachedWeak = await GET(
      makeGetRequest('', { 'if-none-match': `W/${etag}` }),
    )
    expect(cachedWeak.status).toBe(304)
  })

  it('supports content negotiation for application/graphql and application/json', async () => {
    const graphqlRes = await GET(
      makeGetRequest('', { accept: 'application/graphql' }),
    )
    expect(graphqlRes.status).toBe(200)
    expect(graphqlRes.headers.get('content-type')).toContain(
      'application/graphql',
    )
    const graphqlText = await graphqlRes.text()
    expect(graphqlText).toContain('type Query {')

    const jsonRes = await GET(
      makeGetRequest('', { accept: 'application/json' }),
    )
    expect(jsonRes.status).toBe(200)
    expect(jsonRes.headers.get('content-type')).toContain('application/json')
    const jsonBody = await jsonRes.json()
    expect(jsonBody.sdl).toBe(graphqlText)
    expect(jsonBody.schemaHash).toBe(graphqlRes.headers.get('x-schema-hash'))
  })
})
