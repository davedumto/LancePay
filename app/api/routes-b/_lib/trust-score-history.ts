export type TrustScoreSnapshot = {
  date: string
  score: number
}

export const MAX_RETENTION_DAYS = 365
export const ALLOWED_RANGE_DAYS = [30, 90, 365] as const
export type AllowedRangeDays = typeof ALLOWED_RANGE_DAYS[number]

const userHistory = new Map<string, TrustScoreSnapshot[]>()

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function compareDateAsc(a: TrustScoreSnapshot, b: TrustScoreSnapshot): number {
  return a.date.localeCompare(b.date)
}

export function recordTrustScoreSnapshot(
  userId: string,
  score: number,
  now: Date = new Date(),
): void {
  const day = isoDay(now)
  const existing = userHistory.get(userId) ?? []
  const idx = existing.findIndex(snap => snap.date === day)

  if (idx >= 0) {
    existing[idx] = { date: day, score }
  } else {
    existing.push({ date: day, score })
    existing.sort(compareDateAsc)
  }

  while (existing.length > MAX_RETENTION_DAYS) {
    existing.shift()
  }

  userHistory.set(userId, existing)
}

export function getTrustScoreHistory(
  userId: string,
  days: number,
  now: Date = new Date(),
): TrustScoreSnapshot[] {
  if (!Number.isFinite(days) || days <= 0) return []
  const stored = userHistory.get(userId)
  if (!stored || stored.length === 0) return []

  const cutoff = new Date(now)
  cutoff.setUTCHours(0, 0, 0, 0)
  cutoff.setUTCDate(cutoff.getUTCDate() - (days - 1))
  const cutoffIso = isoDay(cutoff)

  return stored
    .filter(snap => snap.date >= cutoffIso)
    .map(snap => ({ ...snap }))
}

export function isAllowedRange(value: unknown): value is AllowedRangeDays {
  return ALLOWED_RANGE_DAYS.includes(value as AllowedRangeDays)
}

export function resetTrustScoreHistoryStore(): void {
  userHistory.clear()
}
