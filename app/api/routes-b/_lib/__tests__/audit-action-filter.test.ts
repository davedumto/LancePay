/**
 * Tests for buildActionFilter — Issue #621
 */

import { describe, it, expect } from 'vitest'
import { buildActionFilter } from '../audit-action-filter'

function params(record: Record<string, string>): URLSearchParams {
  return new URLSearchParams(record)
}

describe('buildActionFilter (#621)', () => {
  it('returns empty clause when both filters are missing', () => {
    const result = buildActionFilter(params({}))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.clause).toEqual({})
  })

  it('builds equals filter for ?action', () => {
    const result = buildActionFilter(params({ action: 'refund.created' }))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.clause).toEqual({ eventType: { equals: 'refund.created' } })
    }
  })

  it('builds startsWith filter for ?actionPrefix', () => {
    const result = buildActionFilter(params({ actionPrefix: 'webhook.' }))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.clause).toEqual({ eventType: { startsWith: 'webhook.' } })
    }
  })

  it('rejects actionPrefix shorter than 2 chars', () => {
    const result = buildActionFilter(params({ actionPrefix: 'a' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/2 and 64/)
  })

  it('rejects actionPrefix longer than 64 chars', () => {
    const result = buildActionFilter(params({ actionPrefix: 'x'.repeat(65) }))
    expect(result.ok).toBe(false)
  })

  it('action takes precedence when both are present', () => {
    const result = buildActionFilter(
      params({ action: 'refund.created', actionPrefix: 'webhook.' }),
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.clause).toEqual({ eventType: { equals: 'refund.created' } })
    }
  })

  it('trims whitespace from inputs', () => {
    const result = buildActionFilter(params({ action: '  refund.created  ' }))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.clause).toEqual({ eventType: { equals: 'refund.created' } })
    }
  })

  it('treats empty string action as missing', () => {
    const result = buildActionFilter(params({ action: '   ' }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.clause).toEqual({})
  })
})
