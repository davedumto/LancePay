import { describe, it, expect } from 'vitest'
import { computeTrustScoreComponents } from '../../../_lib/trust-score-components'

describe('trust-score explain components', () => {
  it('returns all four components', () => {
    const { components } = computeTrustScoreComponents(0, 0, 0)
    const names = components.map(c => c.name)
    expect(names).toContain('payment_history')
    expect(names).toContain('dispute_rate')
    expect(names).toContain('account_age')
    expect(names).toContain('withdrawal_consistency')
  })

  it('weights sum to 1.0', () => {
    const { components } = computeTrustScoreComponents(0, 0, 0)
    const totalWeight = components.reduce((sum, c) => sum + c.weight, 0)
    expect(totalWeight).toBeCloseTo(1.0, 10)
  })

  it('contributions sum to score', () => {
    const cases = [
      [5000, 10, 2],
      [0, 0, 0],
      [100000, 50, 5],
      [1000, 1, 0],
    ]
    for (const [volume, invoices, disputes] of cases) {
      const { score, components } = computeTrustScoreComponents(volume, invoices, disputes)
      const totalContribution = components.reduce((sum, c) => sum + c.contribution, 0)
      expect(totalContribution).toBe(score)
    }
  })

  it('explanation matches computeTrustScore output', () => {
    const { score, components } = computeTrustScoreComponents(5000, 10, 1)
    const totalContribution = components.reduce((sum, c) => sum + c.contribution, 0)
    expect(score).toBe(totalContribution)
  })

  it('dispute_rate contribution is negative or zero', () => {
    const { components } = computeTrustScoreComponents(0, 0, 3)
    const dispute = components.find(c => c.name === 'dispute_rate')!
    expect(dispute.contribution).toBeLessThanOrEqual(0)
  })

  it('component metadata is stable across calls', () => {
    const a = computeTrustScoreComponents(1000, 5, 0)
    const b = computeTrustScoreComponents(2000, 10, 2)
    const aNames = a.components.map(c => c.name)
    const bNames = b.components.map(c => c.name)
    expect(aNames).toEqual(bNames)
    const aWeights = a.components.map(c => c.weight)
    const bWeights = b.components.map(c => c.weight)
    expect(aWeights).toEqual(bWeights)
  })
})
