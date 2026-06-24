/**
 * Tests for webhook backoff config — Issue #607
 */

import { describe, it, expect } from 'vitest'
import {
  validateBackoff,
  computeBackoffDelay,
  DEFAULT_BACKOFF,
} from '../webhook-backoff'

describe('validateBackoff (#607)', () => {
  it('returns defaults when input is null', () => {
    const result = validateBackoff(null)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual(DEFAULT_BACKOFF)
  })

  it('merges partial config with defaults', () => {
    const result = validateBackoff({ initialMs: 500 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.initialMs).toBe(500)
      expect(result.value.maxMs).toBe(DEFAULT_BACKOFF.maxMs)
    }
  })

  it('rejects initialMs below 50', () => {
    const result = validateBackoff({ initialMs: 10 })
    expect(result.ok).toBe(false)
  })

  it('rejects initialMs above 5000', () => {
    const result = validateBackoff({ initialMs: 6000 })
    expect(result.ok).toBe(false)
  })

  it('rejects maxMs below initialMs', () => {
    const result = validateBackoff({ initialMs: 1000, maxMs: 500 })
    expect(result.ok).toBe(false)
  })

  it('rejects maxMs above 60000', () => {
    const result = validateBackoff({ maxMs: 70_000 })
    expect(result.ok).toBe(false)
  })

  it('rejects multiplier below 1', () => {
    const result = validateBackoff({ multiplier: 0.5 })
    expect(result.ok).toBe(false)
  })

  it('rejects multiplier above 5', () => {
    const result = validateBackoff({ multiplier: 6 })
    expect(result.ok).toBe(false)
  })

  it('rejects jitter outside [0, 1]', () => {
    expect(validateBackoff({ jitter: -0.1 }).ok).toBe(false)
    expect(validateBackoff({ jitter: 1.1 }).ok).toBe(false)
  })

  it('accepts boundary values', () => {
    const result = validateBackoff({
      initialMs: 50,
      maxMs: 60_000,
      multiplier: 5,
      jitter: 0,
    })
    expect(result.ok).toBe(true)
  })
})

describe('computeBackoffDelay (#607)', () => {
  it('returns initialMs for attempt 0 with zero jitter', () => {
    const delay = computeBackoffDelay(
      0,
      { ...DEFAULT_BACKOFF, jitter: 0 },
      () => 0.5,
    )
    expect(delay).toBe(DEFAULT_BACKOFF.initialMs)
  })

  it('multiplies on each successive attempt', () => {
    const cfg = { initialMs: 100, maxMs: 10_000, multiplier: 2, jitter: 0 }
    expect(computeBackoffDelay(0, cfg, () => 0.5)).toBe(100)
    expect(computeBackoffDelay(1, cfg, () => 0.5)).toBe(200)
    expect(computeBackoffDelay(2, cfg, () => 0.5)).toBe(400)
    expect(computeBackoffDelay(3, cfg, () => 0.5)).toBe(800)
  })

  it('caps at maxMs', () => {
    const cfg = { initialMs: 100, maxMs: 500, multiplier: 2, jitter: 0 }
    expect(computeBackoffDelay(10, cfg, () => 0.5)).toBe(500)
  })

  it('respects jitter bounds', () => {
    const cfg = { initialMs: 1000, maxMs: 10_000, multiplier: 1, jitter: 0.5 }
    // With random()=0 → variance = 1000*0.5*-0.5 = -250 → 750
    // With random()=1 → variance = 1000*0.5*0.5 = 250 → 1250
    expect(computeBackoffDelay(0, cfg, () => 0)).toBe(750)
    expect(computeBackoffDelay(0, cfg, () => 1)).toBe(1250)
  })

  it('never returns negative delays', () => {
    const cfg = { initialMs: 100, maxMs: 10_000, multiplier: 1, jitter: 1 }
    expect(computeBackoffDelay(0, cfg, () => -10)).toBeGreaterThanOrEqual(0)
  })
})
