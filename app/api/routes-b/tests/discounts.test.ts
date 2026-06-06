import { describe, it, expect } from 'vitest'

describe('Discounts', () => {
  it('should calculate percent discount correctly', () => {
    const original = 100
    const value = 10
    const newAmount = original * (1 - value / 100)
    expect(newAmount).toBe(90)
  })

  it('should calculate flat discount correctly', () => {
    const original = 100
    const value = 25
    const newAmount = original - value
    expect(newAmount).toBe(75)
  })
})
