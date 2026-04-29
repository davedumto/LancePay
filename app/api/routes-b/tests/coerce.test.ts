import { describe, expect, it } from 'vitest'
import { BadRequest, toBool, toInt, toCsvArray, toIsoDate } from '../_lib/coerce'

describe('toBool', () => {
  it('returns true for "true"', () => expect(toBool('true', 'f')).toBe(true))
  it('returns true for "1"', () => expect(toBool('1', 'f')).toBe(true))
  it('returns true for "yes"', () => expect(toBool('yes', 'f')).toBe(true))
  it('returns true for "TRUE" (case-insensitive)', () => expect(toBool('TRUE', 'f')).toBe(true))
  it('returns false for "false"', () => expect(toBool('false', 'f')).toBe(false))
  it('returns false for "0"', () => expect(toBool('0', 'f')).toBe(false))
  it('returns false for "no"', () => expect(toBool('no', 'f')).toBe(false))
  it('uses default when null', () => expect(toBool(null, 'f', false)).toBe(false))
  it('uses default when undefined', () => expect(toBool(undefined, 'f', true)).toBe(true))
  it('throws BadRequest for garbage input', () => {
    expect(() => toBool('maybe', 'flag')).toThrow(BadRequest)
  })
  it('throws BadRequest when required and missing', () => {
    expect(() => toBool(null, 'flag')).toThrow(BadRequest)
  })
  it('BadRequest carries the field name', () => {
    try {
      toBool('garbage', 'myFlag')
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequest)
      expect((err as BadRequest).field).toBe('myFlag')
    }
  })
})

describe('toInt', () => {
  it('parses a valid integer string', () => expect(toInt('42', 'n')).toBe(42))
  it('parses a negative integer', () => expect(toInt('-5', 'n')).toBe(-5))
  it('parses zero', () => expect(toInt('0', 'n')).toBe(0))
  it('uses default when null', () => expect(toInt(null, 'n', { default: 10 })).toBe(10))
  it('uses default when undefined', () => expect(toInt(undefined, 'n', { default: 5 })).toBe(5))
  it('throws for float string "3.14"', () => {
    expect(() => toInt('3.14', 'n')).toThrow(BadRequest)
  })
  it('throws for non-numeric garbage', () => {
    expect(() => toInt('abc', 'n')).toThrow(BadRequest)
  })
  it('throws for partially numeric "10abc"', () => {
    expect(() => toInt('10abc', 'n')).toThrow(BadRequest)
  })
  it('respects min bound', () => {
    expect(() => toInt('0', 'n', { min: 1 })).toThrow(BadRequest)
  })
  it('respects max bound', () => {
    expect(() => toInt('100', 'n', { max: 50 })).toThrow(BadRequest)
  })
  it('passes when value equals min', () => {
    expect(toInt('1', 'n', { min: 1 })).toBe(1)
  })
  it('passes when value equals max', () => {
    expect(toInt('50', 'n', { max: 50 })).toBe(50)
  })
  it('throws when required and missing', () => {
    expect(() => toInt(null, 'n')).toThrow(BadRequest)
  })
})

describe('toCsvArray', () => {
  it('splits a comma-separated string', () => {
    expect(toCsvArray('a,b,c', 'f')).toEqual(['a', 'b', 'c'])
  })
  it('trims whitespace around entries', () => {
    expect(toCsvArray('a , b , c', 'f')).toEqual(['a', 'b', 'c'])
  })
  it('deduplicates entries', () => {
    expect(toCsvArray('a,b,a,c', 'f')).toEqual(['a', 'b', 'c'])
  })
  it('returns empty array for null', () => {
    expect(toCsvArray(null, 'f')).toEqual([])
  })
  it('returns empty array for undefined', () => {
    expect(toCsvArray(undefined, 'f')).toEqual([])
  })
  it('returns empty array for empty string', () => {
    expect(toCsvArray('', 'f')).toEqual([])
  })
  it('returns default when null and default provided', () => {
    expect(toCsvArray(null, 'f', { default: ['x'] })).toEqual(['x'])
  })
  it('filters out blank-only entries after split', () => {
    expect(toCsvArray('a,,b', 'f')).toEqual(['a', 'b'])
  })
  it('handles a single value without comma', () => {
    expect(toCsvArray('only', 'f')).toEqual(['only'])
  })
})

describe('toIsoDate', () => {
  it('parses a valid YYYY-MM-DD string', () => {
    const d = toIsoDate('2024-06-15', 'date')
    expect(d).toBeInstanceOf(Date)
    expect(d.toISOString()).toContain('2024-06-15')
  })
  it('uses default when null', () => {
    const def = new Date('2024-01-01T00:00:00.000Z')
    expect(toIsoDate(null, 'date', { default: def })).toBe(def)
  })
  it('uses default when undefined', () => {
    const def = new Date('2024-01-01T00:00:00.000Z')
    expect(toIsoDate(undefined, 'date', { default: def })).toBe(def)
  })
  it('throws for wrong format (DD-MM-YYYY)', () => {
    expect(() => toIsoDate('15-06-2024', 'date')).toThrow(BadRequest)
  })
  it('throws for garbage string', () => {
    expect(() => toIsoDate('not-a-date', 'date')).toThrow(BadRequest)
  })
  it('throws for invalid calendar date (month 13)', () => {
    expect(() => toIsoDate('2024-13-01', 'date')).toThrow(BadRequest)
  })
  it('throws for invalid calendar date (day 32)', () => {
    expect(() => toIsoDate('2024-01-32', 'date')).toThrow(BadRequest)
  })
  it('throws when required and missing', () => {
    expect(() => toIsoDate(null, 'date')).toThrow(BadRequest)
  })
  it('BadRequest carries the field name', () => {
    try {
      toIsoDate('bad', 'myDate')
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequest)
      expect((err as BadRequest).field).toBe('myDate')
    }
  })
})
