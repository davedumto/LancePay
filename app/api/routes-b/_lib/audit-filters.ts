const DEFAULT_RANGE_DAYS = 90
const MAX_RANGE_DAYS = 365
const DAY_MS = 24 * 60 * 60 * 1000

export type AuditFiltersResult =
  | { ok: true; value: { from: Date; to: Date; actor?: string } }
  | { ok: false; error: string }

function parseIsoDate(value: string, name: string): { ok: true; date: Date } | { ok: false; error: string } {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return { ok: false, error: `${name} must be a valid ISO 8601 date` }
  }

  return { ok: true, date }
}

export function parseAuditFilters(searchParams: URLSearchParams, now = new Date()): AuditFiltersResult {
  const fromParam = searchParams.get('from')
  const toParam = searchParams.get('to')
  const actor = searchParams.get('actor')?.trim()
  const to = toParam ? parseIsoDate(toParam, 'to') : { ok: true as const, date: now }

  if (!to.ok) return { ok: false, error: to.error }

  const defaultFrom = new Date(to.date.getTime() - DEFAULT_RANGE_DAYS * DAY_MS)
  const from = fromParam ? parseIsoDate(fromParam, 'from') : { ok: true as const, date: defaultFrom }

  if (!from.ok) return { ok: false, error: from.error }

  if (from.date.getTime() > to.date.getTime()) {
    return { ok: false, error: 'from must be before or equal to to' }
  }

  if (to.date.getTime() - from.date.getTime() > MAX_RANGE_DAYS * DAY_MS) {
    return { ok: false, error: `date range cannot exceed ${MAX_RANGE_DAYS} days` }
  }

  return {
    ok: true,
    value: {
      from: from.date,
      to: to.date,
      ...(actor ? { actor } : {}),
    },
  }
}
