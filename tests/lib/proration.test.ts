import { describe, it, expect } from 'vitest'
import { Decimal } from '@prisma/client/runtime/library'
import { billingPeriodStart, calculateProration } from '@/lib/proration'
import { parsePositiveMoney, roundMoney } from '@/lib/money'

const d = (iso: string) => new Date(iso)

describe('billingPeriodStart', () => {
  it('subtracts whole days for daily and weekly periods', () => {
    expect(billingPeriodStart(d('2026-03-10T09:00:00.000Z'), 'daily', 3).toISOString()).toBe(
      '2026-03-07T09:00:00.000Z',
    )
    expect(billingPeriodStart(d('2026-03-10T09:00:00.000Z'), 'weekly', 2).toISOString()).toBe(
      '2026-02-24T09:00:00.000Z',
    )
  })

  it('subtracts calendar months in UTC, keeping the time of day', () => {
    expect(billingPeriodStart(d('2026-05-15T18:30:00.000Z'), 'monthly', 1).toISOString()).toBe(
      '2026-04-15T18:30:00.000Z',
    )
    expect(billingPeriodStart(d('2026-02-01T00:00:00.000Z'), 'monthly', 3).toISOString()).toBe(
      '2025-11-01T00:00:00.000Z',
    )
  })

  it('clamps to the last day of a shorter month', () => {
    expect(billingPeriodStart(d('2026-03-31T00:00:00.000Z'), 'monthly', 1).toISOString()).toBe(
      '2026-02-28T00:00:00.000Z',
    )
    expect(billingPeriodStart(d('2028-03-31T00:00:00.000Z'), 'monthly', 1).toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    )
  })

  it('handles yearly periods across a leap day', () => {
    expect(billingPeriodStart(d('2029-02-28T00:00:00.000Z'), 'yearly', 1).toISOString()).toBe(
      '2028-02-28T00:00:00.000Z',
    )
    expect(billingPeriodStart(d('2028-02-29T00:00:00.000Z'), 'yearly', 1).toISOString()).toBe(
      '2027-02-28T00:00:00.000Z',
    )
  })
})

describe('calculateProration', () => {
  const periodStart = d('2026-02-01T00:00:00.000Z')
  const periodEnd = d('2026-03-01T00:00:00.000Z') // 28 days

  it('credits unused time and charges remaining time, netting them (upgrade)', () => {
    const result = calculateProration({
      currentAmount: new Decimal('100.00'),
      newAmount: new Decimal('200.00'),
      periodStart,
      periodEnd,
      changeAt: d('2026-02-15T00:00:00.000Z'),
    })
    expect(result.direction).toBe('upgrade')
    expect(result.remainingMs).toBe(14 * 86_400_000)
    expect(result.periodMs).toBe(28 * 86_400_000)
    expect(result.credit.toFixed(2)).toBe('50.00')
    expect(result.charge.toFixed(2)).toBe('100.00')
    expect(result.netAmount.toFixed(2)).toBe('50.00')
  })

  it('produces a negative net (credit) for a downgrade', () => {
    const result = calculateProration({
      currentAmount: new Decimal('200.00'),
      newAmount: new Decimal('50.00'),
      periodStart,
      periodEnd,
      changeAt: d('2026-02-22T00:00:00.000Z'),
    })
    expect(result.direction).toBe('downgrade')
    expect(result.credit.toFixed(2)).toBe('50.00')
    expect(result.charge.toFixed(2)).toBe('12.50')
    expect(result.netAmount.toFixed(2)).toBe('-37.50')
  })

  it('rounds each component to cents so the net reconciles exactly', () => {
    const result = calculateProration({
      currentAmount: new Decimal('10.00'),
      newAmount: new Decimal('20.00'),
      periodStart: d('2026-04-01T00:00:00.000Z'),
      periodEnd: d('2026-05-01T00:00:00.000Z'),
      changeAt: d('2026-04-11T00:00:00.000Z'), // 20 of 30 days remain
    })
    expect(result.credit.toFixed(2)).toBe('6.67')
    expect(result.charge.toFixed(2)).toBe('13.33')
    expect(result.netAmount.toFixed(2)).toBe('6.66')
    expect(result.charge.minus(result.credit).eq(result.netAmount)).toBe(true)
  })

  it('uses the full period at the start boundary and nothing at the end boundary', () => {
    const base = { currentAmount: new Decimal('30'), newAmount: new Decimal('90'), periodStart, periodEnd }
    const atStart = calculateProration({ ...base, changeAt: periodStart })
    expect(atStart.credit.toFixed(2)).toBe('30.00')
    expect(atStart.charge.toFixed(2)).toBe('90.00')
    expect(atStart.netAmount.toFixed(2)).toBe('60.00')

    const atEnd = calculateProration({ ...base, changeAt: periodEnd })
    expect(atEnd.credit.toFixed(2)).toBe('0.00')
    expect(atEnd.charge.toFixed(2)).toBe('0.00')
    expect(atEnd.netAmount.isZero()).toBe(true)
  })
})

describe('money helpers', () => {
  it('parses positive amounts with at most two decimals', () => {
    expect(parsePositiveMoney(12.5)?.toFixed(2)).toBe('12.50')
    expect(parsePositiveMoney('0.01')?.toFixed(2)).toBe('0.01')
    expect(parsePositiveMoney('99999999.99')?.toFixed(2)).toBe('99999999.99')
  })

  it.each([0, -1, '1.001', 'abc', '', null, undefined, Number.NaN, Infinity, '1e3', '100000000.00', {}])(
    'rejects %s',
    (value) => {
      expect(parsePositiveMoney(value)).toBeNull()
    },
  )

  it('rounds half away from zero', () => {
    expect(roundMoney(new Decimal('2.345')).toFixed(2)).toBe('2.35')
    expect(roundMoney(new Decimal('2.344')).toFixed(2)).toBe('2.34')
  })
})
