const DAY_MS = 24 * 60 * 60 * 1000

export type AgeingBucketKey = '1_30' | '31_60' | '61_90' | '90_plus'

export type AgeingBuckets<T> = Record<AgeingBucketKey, T[]>

export function emptyAgeingBuckets<T>(): AgeingBuckets<T> {
  return {
    '1_30': [],
    '31_60': [],
    '61_90': [],
    '90_plus': [],
  }
}

export function getDaysOverdueUtc(dueDate: Date, now: Date = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - dueDate.getTime()) / DAY_MS))
}

export function getAgeingBucket(daysOverdue: number): AgeingBucketKey {
  if (daysOverdue <= 30) return '1_30'
  if (daysOverdue <= 60) return '31_60'
  if (daysOverdue <= 90) return '61_90'
  return '90_plus'
}
