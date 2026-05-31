import { describe, it, expect } from 'vitest'
import { buildLinkHeader } from '../link-header'

describe('link-header', () => {
  it('builds Link header with next cursor (RFC format)', () => {
    const url = 'https://example.com/api/routes-b/invoices?status=pending'
    const nextCursor = 'eyJjdGFpbGVyX2F0IjoiMjAyNC0wMS0wMSIsImlkIjoiMSJ9'

    const result = buildLinkHeader(url, nextCursor)

    expect(result).toBe(`<https://example.com/api/routes-b/invoices?status=pending&cursor=${nextCursor}>; rel="next"`)
  })

  it('preserves other query params', () => {
    const url = 'https://example.com/api/routes-b/invoices?status=pending&limit=10'
    const nextCursor = 'abc123'

    const result = buildLinkHeader(url, nextCursor)

    expect(result).toBe(`<https://example.com/api/routes-b/invoices?status=pending&limit=10&cursor=abc123>; rel="next"`)
  })

  it('returns null when no next cursor', () => {
    const url = 'https://example.com/api/routes-b/invoices'

    const result = buildLinkHeader(url, null)

    expect(result).toBeNull()
  })

  it('returns null for empty cursor', () => {
    const url = 'https://example.com/api/routes-b/invoices'

    const result = buildLinkHeader(url, '')

    expect(result).toBeNull()
  })
})