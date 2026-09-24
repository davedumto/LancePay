import { describe, it, expect } from 'vitest'
import {
  combineRates,
  resolveRateChain,
  rangesOverlap,
  type ChainNode,
} from '@/lib/tax-rates'

describe('combineRates', () => {
  it('returns 0 for an empty chain', () => {
    expect(combineRates([])).toBe(0)
  })

  it('returns the single rate for a one-element chain', () => {
    expect(combineRates([{ id: 'a', name: 'VAT', rate: 0.1 }])).toBeCloseTo(0.1)
  })

  it('compounds multiplicatively rather than summing', () => {
    // (1 + 0.1) * (1 + 0.05) - 1 = 0.155, not 0.15
    const combined = combineRates([
      { id: 'a', name: 'Federal', rate: 0.1 },
      { id: 'b', name: 'State', rate: 0.05 },
    ])
    expect(combined).toBeCloseTo(0.155)
  })
})

describe('resolveRateChain', () => {
  it('orders components from root parent to leaf', () => {
    const nodes = new Map<string, ChainNode>([
      ['root', { id: 'root', name: 'Federal', rate: 0.1, parentRateId: null }],
      ['leaf', { id: 'leaf', name: 'State', rate: 0.05, parentRateId: 'root' }],
    ])
    const chain = resolveRateChain('leaf', nodes)
    expect(chain.map((c) => c.id)).toEqual(['root', 'leaf'])
  })

  it('throws on a cyclic reference', () => {
    const nodes = new Map<string, ChainNode>([
      ['a', { id: 'a', name: 'A', rate: 0.1, parentRateId: 'b' }],
      ['b', { id: 'b', name: 'B', rate: 0.1, parentRateId: 'a' }],
    ])
    expect(() => resolveRateChain('a', nodes)).toThrow(/Cyclic/)
  })

  it('throws when a referenced node is missing', () => {
    const nodes = new Map<string, ChainNode>([
      ['a', { id: 'a', name: 'A', rate: 0.1, parentRateId: 'missing' }],
    ])
    expect(() => resolveRateChain('a', nodes)).toThrow(/Missing/)
  })
})

describe('rangesOverlap', () => {
  const d = (s: string) => new Date(s)

  it('detects overlapping closed ranges', () => {
    expect(
      rangesOverlap(d('2026-01-01'), d('2026-06-01'), d('2026-03-01'), d('2026-09-01')),
    ).toBe(true)
  })

  it('treats adjacent half-open ranges as non-overlapping', () => {
    expect(
      rangesOverlap(d('2026-01-01'), d('2026-06-01'), d('2026-06-01'), d('2026-12-01')),
    ).toBe(false)
  })

  it('treats a null upper bound as open-ended', () => {
    expect(
      rangesOverlap(d('2026-01-01'), null, d('2030-01-01'), null),
    ).toBe(true)
  })

  it('returns false for fully separated ranges', () => {
    expect(
      rangesOverlap(d('2026-01-01'), d('2026-02-01'), d('2026-03-01'), d('2026-04-01')),
    ).toBe(false)
  })
})
