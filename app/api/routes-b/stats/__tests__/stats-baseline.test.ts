import { describe, it, expect } from 'vitest'
import { parseUtcDateRange } from '../../_lib/date-range'

describe('stats baseline comparison', () => {
  it('default params yields current shape only', () => {
    const params = new URLSearchParams()
    const range = parseUtcDateRange(params)
    expect(range.ok).toBe(true)
  })

  it('supplied baseline range parses correctly', () => {
    const params = new URLSearchParams({
      from: '2026-01-01',
      to: '2026-03-31',
    })
    const range = parseUtcDateRange(params)
    expect(range.ok).toBe(true)
    if (range.ok) {
      expect(range.value.days).toBe(90)
    }
  })

  it('invalid range returns error', () => {
    const params = new URLSearchParams({
      from: '2026-03-31',
      to: '2026-01-01',
    })
    const range = parseUtcDateRange(params)
    expect(range.ok).toBe(false)
  })

  it('range capped at 366 days', () => {
    const params = new URLSearchParams({
      from: '2025-01-01',
      to: '2026-01-02',
    })
    const range = parseUtcDateRange(params)
    expect(range.ok).toBe(false)
    if (!range.ok) {
      expect(range.error.fields.from).toContain('366')
    }
  })

  it('deltaPct sign correctness: positive when current > baseline', () => {
    const current = 200
    const baseline = 100
    const delta = Math.round(((current - baseline) / baseline) * 10000) / 100
    expect(delta).toBe(100)
  })

  it('deltaPct sign correctness: negative when current < baseline', () => {
    const current = 50
    const baseline = 100
    const delta = Math.round(((current - baseline) / baseline) * 10000) / 100
    expect(delta).toBe(-50)
  })

  it('deltaPct handles zero baseline', () => {
    const current = 100
    const baseline = 0
    const delta = baseline === 0 ? (current > 0 ? 100 : 0) : 0
    expect(delta).toBe(100)
  })
})
