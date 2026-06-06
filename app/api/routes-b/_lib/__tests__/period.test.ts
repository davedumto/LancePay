import { describe, it, expect } from 'vitest'
import { getUtcPeriodBoundaries, calculateDelta } from '../period'

describe('Period Helper', () => {
  describe('getUtcPeriodBoundaries', () => {
    it('calculates daily boundaries correctly', () => {
      const now = new Date(Date.UTC(2024, 0, 15, 12, 0, 0)) // 2024-01-15 12:00 UTC
      const boundaries = getUtcPeriodBoundaries('day', now)
      
      expect(boundaries.current.start.toISOString()).toBe('2024-01-15T00:00:00.000Z')
      expect(boundaries.current.end.toISOString()).toBe('2024-01-16T00:00:00.000Z')
      expect(boundaries.previous.start.toISOString()).toBe('2024-01-14T00:00:00.000Z')
      expect(boundaries.previous.end.toISOString()).toBe('2024-01-15T00:00:00.000Z')
    })

    it('calculates weekly boundaries (ISO weeks - Monday)', () => {
      // 2024-01-17 is Wednesday
      const now = new Date(Date.UTC(2024, 0, 17, 12, 0, 0))
      const boundaries = getUtcPeriodBoundaries('week', now)
      
      // Monday of this week
      expect(boundaries.current.start.toISOString()).toBe('2024-01-15T00:00:00.000Z')
      // Next Monday
      expect(boundaries.current.end.toISOString()).toBe('2024-01-22T00:00:00.000Z')
      // Monday of previous week
      expect(boundaries.previous.start.toISOString()).toBe('2024-01-08T00:00:00.000Z')
      expect(boundaries.previous.end.toISOString()).toBe('2024-01-15T00:00:00.000Z')
    })

    it('handles week boundaries when today is Sunday', () => {
      // 2024-01-21 is Sunday
      const now = new Date(Date.UTC(2024, 0, 21, 12, 0, 0))
      const boundaries = getUtcPeriodBoundaries('week', now)
      
      expect(boundaries.current.start.toISOString()).toBe('2024-01-15T00:00:00.000Z')
      expect(boundaries.current.end.toISOString()).toBe('2024-01-22T00:00:00.000Z')
    })

    it('calculates monthly boundaries', () => {
      const now = new Date(Date.UTC(2024, 1, 15, 12, 0, 0)) // 2024-02-15
      const boundaries = getUtcPeriodBoundaries('month', now)
      
      expect(boundaries.current.start.toISOString()).toBe('2024-02-01T00:00:00.000Z')
      expect(boundaries.current.end.toISOString()).toBe('2024-03-01T00:00:00.000Z')
      expect(boundaries.previous.start.toISOString()).toBe('2024-01-01T00:00:00.000Z')
      expect(boundaries.previous.end.toISOString()).toBe('2024-02-01T00:00:00.000Z')
    })

    it('handles leap year boundaries (Feb 29)', () => {
      const now = new Date(Date.UTC(2024, 1, 29, 12, 0, 0))
      const boundaries = getUtcPeriodBoundaries('day', now)
      
      expect(boundaries.current.start.toISOString()).toBe('2024-02-29T00:00:00.000Z')
      expect(boundaries.current.end.toISOString()).toBe('2024-03-01T00:00:00.000Z')
      expect(boundaries.previous.start.toISOString()).toBe('2024-02-28T00:00:00.000Z')
    })

    it('calculates yearly boundaries', () => {
      const now = new Date(Date.UTC(2024, 5, 15, 12, 0, 0))
      const boundaries = getUtcPeriodBoundaries('year', now)
      
      expect(boundaries.current.start.toISOString()).toBe('2024-01-01T00:00:00.000Z')
      expect(boundaries.current.end.toISOString()).toBe('2025-01-01T00:00:00.000Z')
      expect(boundaries.previous.start.toISOString()).toBe( '2023-01-01T00:00:00.000Z')
      expect(boundaries.previous.end.toISOString()).toBe('2024-01-01T00:00:00.000Z')
    })
  })

  describe('calculateDelta', () => {
    it('calculates positive growth', () => {
      expect(calculateDelta(150, 100)).toBe(50)
    })

    it('calculates negative growth', () => {
      expect(calculateDelta(50, 100)).toBe(-50)
    })

    it('handles zero previous value', () => {
      expect(calculateDelta(100, 0)).toBe(100)
      expect(calculateDelta(0, 0)).toBe(0)
    })

    it('rounds to 2 decimal places', () => {
      expect(calculateDelta(1, 3)).toBe(-66.67)
    })
  })
})
