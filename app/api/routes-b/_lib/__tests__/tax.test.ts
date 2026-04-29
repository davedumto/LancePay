import { describe, it, expect } from 'vitest'
import { computeTax } from '../tax'

describe('computeTax', () => {
  it('NG region returns 7.5% VAT', () => {
    const result = computeTax(100, 'NG', 'standard')
    expect(result.rate).toBe(0.075)
    expect(result.amount).toBe(7.5)
    expect(result.total).toBe(107.5)
  })

  it('GB region returns 20% VAT', () => {
    const result = computeTax(100, 'GB', 'standard')
    expect(result.rate).toBe(0.2)
    expect(result.amount).toBe(20)
    expect(result.total).toBe(120)
  })

  it('US region returns 0%', () => {
    const result = computeTax(100, 'US', 'standard')
    expect(result.rate).toBe(0)
    expect(result.amount).toBe(0)
    expect(result.total).toBe(100)
  })

  it('unknown region defaults to 0%', () => {
    const result = computeTax(100, 'DE', 'standard')
    expect(result.rate).toBe(0)
    expect(result.amount).toBe(0)
    expect(result.total).toBe(100)
  })

  it('rounds amount to 2 decimal places', () => {
    const result = computeTax(99.99, 'NG', 'standard')
    const decimals = (result.amount.toString().split('.')[1] ?? '').length
    expect(decimals).toBeLessThanOrEqual(2)
  })

  it('total equals subtotal + amount', () => {
    const subtotal = 250
    const result = computeTax(subtotal, 'GB', 'standard')
    expect(result.total).toBeCloseTo(subtotal + result.amount, 2)
  })

  it('region matching is case-insensitive', () => {
    const lower = computeTax(100, 'ng', 'standard')
    const upper = computeTax(100, 'NG', 'standard')
    expect(lower).toEqual(upper)
  })
})
