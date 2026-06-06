export type PeriodType = 'day' | 'week' | 'month' | 'year'

export type PeriodBoundaries = {
  current: { start: Date; end: Date }
  previous: { start: Date; end: Date }
}

/**
 * Calculates UTC period boundaries for the given type relative to 'now'.
 * 'end' boundaries are exclusive (start of the next period).
 */
export function getUtcPeriodBoundaries(type: PeriodType, now = new Date()): PeriodBoundaries {
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()
  const d = now.getUTCDate()

  let currentStart: Date
  let previousStart: Date
  let currentEnd: Date

  switch (type) {
    case 'day':
      currentStart = new Date(Date.UTC(y, m, d))
      previousStart = new Date(Date.UTC(y, m, d - 1))
      currentEnd = new Date(Date.UTC(y, m, d + 1))
      break
    case 'week': {
      // ISO weeks start on Monday. getUTCDay: 0=Sun, 1=Mon, ..., 6=Sat
      const day = now.getUTCDay()
      const diffToMonday = day === 0 ? 6 : day - 1
      currentStart = new Date(Date.UTC(y, m, d - diffToMonday))
      previousStart = new Date(Date.UTC(y, m, d - diffToMonday - 7))
      currentEnd = new Date(Date.UTC(y, m, d - diffToMonday + 7))
      break
    }
    case 'month':
      currentStart = new Date(Date.UTC(y, m, 1))
      previousStart = new Date(Date.UTC(y, m - 1, 1))
      currentEnd = new Date(Date.UTC(y, m + 1, 1))
      break
    case 'year':
      currentStart = new Date(Date.UTC(y, 0, 1))
      previousStart = new Date(Date.UTC(y - 1, 0, 1))
      currentEnd = new Date(Date.UTC(y + 1, 0, 1))
      break
    default:
      throw new Error(`Invalid period type: ${type}`)
  }

  return {
    current: { start: currentStart, end: currentEnd },
    previous: { start: previousStart, end: currentStart },
  }
}

/**
 * Calculates percentage change between current and previous values.
 */
export function calculateDelta(current: number, previous: number): number {
  if (previous === 0) {
    return current === 0 ? 0 : 100
  }
  return Number(((current - previous) / previous * 100).toFixed(2))
}
