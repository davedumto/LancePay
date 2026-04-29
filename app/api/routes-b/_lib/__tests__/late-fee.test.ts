/**
 * Tests for computeLateFee — Issue #599
 */

import { describe, it, expect } from 'vitest'
import { computeLateFee, DEFAULT_LATE_FEE_POLICY } from '../late-fee'

const baseInvoice = {
  amount: 1000,
  currency: 'USD',
  dueDate: new Date('2026-01-01'),
}

describe('computeLateFee (#599)', () => {
  it('returns zero when invoice is not overdue', () => {
    const result = computeLateFee(baseInvoice, new Date('2025-12-31'))
    expect(result.amount).toBe(0)
    expect(result.applied).toBe(false)
    expect(result.daysLate).toBe(0)
  })

  it('returns zero when overdue but less than one period', () => {
    const result = computeLateFee(baseInvoice, new Date('2026-01-15')) // 14 days late
    expect(result.amount).toBe(0)
    expect(result.applied).toBe(false)
    expect(result.daysLate).toBe(14)
  })

  it('charges 1.5% for one full period (30 days)', () => {
    const result = computeLateFee(baseInvoice, new Date('2026-01-31')) // 30 days late
    // 1000 * 0.015 * 1 = 15
    expect(result.amount).toBe(15)
    expect(result.applied).toBe(true)
    expect(result.daysLate).toBe(30)
    expect(result.currency).toBe('USD')
  })

  it('scales linearly across multiple periods', () => {
    const result = computeLateFee(baseInvoice, new Date('2026-04-01')) // 90 days = 3 periods
    // 1000 * 0.015 * 3 = 45
    expect(result.amount).toBe(45)
    expect(result.applied).toBe(true)
  })

  it('caps at 10% of principal', () => {
    // 8 periods (240 days) → would be 12% → cap at 10%
    const result = computeLateFee(baseInvoice, new Date('2026-08-29'))
    expect(result.amount).toBe(100) // 10% of 1000
    expect(result.applied).toBe(true)
  })

  it('returns zero for invoice with no due date', () => {
    const result = computeLateFee(
      { amount: 1000, currency: 'USD', dueDate: null },
      new Date(),
    )
    expect(result.amount).toBe(0)
    expect(result.applied).toBe(false)
  })

  it('preserves currency', () => {
    const result = computeLateFee(
      { ...baseInvoice, currency: 'EUR' },
      new Date('2026-01-31'),
    )
    expect(result.currency).toBe('EUR')
  })

  it('accepts ISO string dates', () => {
    const result = computeLateFee(
      { ...baseInvoice, dueDate: '2026-01-01' },
      '2026-01-31',
    )
    expect(result.amount).toBe(15)
  })

  it('uses default policy when none supplied', () => {
    const result = computeLateFee(baseInvoice, new Date('2026-01-31'))
    expect(result.amount).toBe(1000 * DEFAULT_LATE_FEE_POLICY.ratePerPeriod * 1)
  })

  it('respects custom policy', () => {
    const result = computeLateFee(
      baseInvoice,
      new Date('2026-01-31'),
      { ratePerPeriod: 0.05, periodDays: 30, capFraction: 0.5 },
    )
    expect(result.amount).toBe(50) // 1000 * 0.05 * 1
  })
})
