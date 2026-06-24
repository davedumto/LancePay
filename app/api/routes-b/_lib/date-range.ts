const DEFAULT_RANGE_DAYS = 30
const MAX_RANGE_DAYS = 366
const DAY_IN_MS = 24 * 60 * 60 * 1000

// ── Timezone helpers ──────────────────────────────────────────────────────────

export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/**
 * Returns the UTC instant that corresponds to local midnight (00:00:00) on
 * `dateStr` (YYYY-MM-DD) in timezone `tz`.
 *
 * Uses two iterations so DST-transition days (where the UTC offset at noon
 * differs from the offset at midnight) are handled correctly.
 */
export function localMidnightToUtc(dateStr: string, tz: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number)

  // Start with UTC midnight as the initial candidate.
  let candidate = new Date(Date.UTC(year, month - 1, day, 0, 0, 0))

  for (let i = 0; i < 2; i++) {
    const localStr = candidate.toLocaleString('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })

    // en-US format: "MM/DD/YYYY, HH:MM:SS"
    const [datePart, timePart] = localStr.split(', ')
    const [lm, ld, ly] = datePart.split('/').map(Number)
    const [lh, lmin, ls] = timePart.split(':').map(Number)
    const hour = lh === 24 ? 0 : lh

    // Delta from the target local midnight (treating dates as UTC for arithmetic)
    const currentLocalMs = Date.UTC(ly, lm - 1, ld, hour, lmin, ls)
    const targetLocalMs = Date.UTC(year, month - 1, day, 0, 0, 0)
    candidate = new Date(candidate.getTime() - (currentLocalMs - targetLocalMs))
  }

  return candidate
}

export type ParsedTzDateRange =
  | {
      ok: true
      value: {
        from: Date
        to: Date
        toExclusive: Date
        days: number
        tz: string
      }
    }
  | {
      ok: false
      error: {
        error: string
        fields: Record<string, string>
      }
    }

/**
 * Like `parseUtcDateRange` but projects local-day boundaries to UTC ranges
 * using the supplied (or default) IANA timezone.
 *
 * Falls back to `defaultTz` (e.g. user.timezone) then UTC when `tz` param is absent.
 * Returns 400-shaped error when the timezone name is not a valid IANA identifier.
 */
export function parseTzDateRange(
  searchParams: URLSearchParams,
  defaultTz?: string | null,
  now = new Date(),
): ParsedTzDateRange {
  const rawTz = searchParams.get('tz') ?? defaultTz ?? 'UTC'

  if (!isValidTimezone(rawTz)) {
    return {
      ok: false,
      error: {
        error: 'Invalid timezone',
        fields: { tz: `"${rawTz}" is not a valid IANA timezone name` },
      },
    }
  }

  const rawFrom = searchParams.get('from')
  const rawTo = searchParams.get('to')
  const fields: Record<string, string> = {}

  // Default range: last DEFAULT_RANGE_DAYS local days ending today in `tz`
  const todayLocalStr = now
    .toLocaleDateString('en-CA', { timeZone: rawTz }) // YYYY-MM-DD
  const todayLocal = todayLocalStr

  function parseDateStr(value: string, field: 'from' | 'to') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return { ok: false as const, message: `${field} must use YYYY-MM-DD format` }
    }
    // Light validation: create UTC date and check it's not NaN
    if (Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime())) {
      return { ok: false as const, message: `${field} must be a valid date` }
    }
    return { ok: true as const, value }
  }

  let fromStr = todayLocal
  let toStr = todayLocal

  if (rawFrom) {
    const p = parseDateStr(rawFrom, 'from')
    if (!p.ok) fields.from = p.message
    else fromStr = p.value
  }

  if (rawTo) {
    const p = parseDateStr(rawTo, 'to')
    if (!p.ok) fields.to = p.message
    else toStr = p.value
  }

  if (Object.keys(fields).length > 0) {
    return { ok: false, error: { error: 'Invalid date range', fields } }
  }

  // Apply defaults mirroring parseUtcDateRange behaviour
  if (!rawFrom && !rawTo) {
    // subtract DEFAULT_RANGE_DAYS-1 days from today in local space
    const todayUtcMidnight = localMidnightToUtc(todayLocal, rawTz)
    const fromUtcMidnight = new Date(todayUtcMidnight.getTime() - (DEFAULT_RANGE_DAYS - 1) * DAY_IN_MS)
    fromStr = fromUtcMidnight.toLocaleDateString('en-CA', { timeZone: rawTz })
  } else if (!rawFrom) {
    const toUtcMidnight = localMidnightToUtc(toStr, rawTz)
    const fromUtcMidnight = new Date(toUtcMidnight.getTime() - (DEFAULT_RANGE_DAYS - 1) * DAY_IN_MS)
    fromStr = fromUtcMidnight.toLocaleDateString('en-CA', { timeZone: rawTz })
  } else if (!rawTo) {
    const fromUtcMidnight = localMidnightToUtc(fromStr, rawTz)
    const toUtcMidnight = new Date(fromUtcMidnight.getTime() + (DEFAULT_RANGE_DAYS - 1) * DAY_IN_MS)
    toStr = toUtcMidnight.toLocaleDateString('en-CA', { timeZone: rawTz })
  }

  const from = localMidnightToUtc(fromStr, rawTz)
  const toMidnight = localMidnightToUtc(toStr, rawTz)

  if (from.getTime() > toMidnight.getTime()) {
    return {
      ok: false,
      error: {
        error: 'Invalid date range',
        fields: {
          from: 'from must be on or before to',
          to: 'to must be on or after from',
        },
      },
    }
  }

  // Count local days (by iterating local date strings)
  let days = 0
  let cursor = from
  while (cursor.getTime() <= toMidnight.getTime()) {
    days++
    cursor = new Date(cursor.getTime() + DAY_IN_MS)
  }

  if (days > MAX_RANGE_DAYS) {
    return {
      ok: false,
      error: {
        error: 'Invalid date range',
        fields: {
          from: `date range cannot exceed ${MAX_RANGE_DAYS} days`,
          to: `date range cannot exceed ${MAX_RANGE_DAYS} days`,
        },
      },
    }
  }

  // toExclusive = start of the next local day after toStr
  const toExclusive = localMidnightToUtc(toStr, rawTz)
  // advance by one full day in UTC then re-anchor to local midnight
  const nextDayStr = new Date(toExclusive.getTime() + DAY_IN_MS)
    .toLocaleDateString('en-CA', { timeZone: rawTz })
  const toExclusiveDate = localMidnightToUtc(nextDayStr, rawTz)

  return {
    ok: true,
    value: {
      from,
      to: toMidnight,
      toExclusive: toExclusiveDate,
      days,
      tz: rawTz,
    },
  }
}

export type ParsedDateRange =
  | {
      ok: true
      value: {
        from: Date
        to: Date
        toExclusive: Date
        days: number
      }
    }
  | {
      ok: false
      error: {
        error: string
        fields: Record<string, string>
      }
    }

function utcMidnight(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * DAY_IN_MS)
}

function parseDateParam(value: string, field: 'from' | 'to') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return {
      ok: false as const,
      message: `${field} must use YYYY-MM-DD format`,
    }
  }

  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime())) {
    return {
      ok: false as const,
      message: `${field} must be a valid date`,
    }
  }

  return {
    ok: true as const,
    value: utcMidnight(parsed),
  }
}

export function parseUtcDateRange(searchParams: URLSearchParams, now = new Date()): ParsedDateRange {
  const rawFrom = searchParams.get('from')
  const rawTo = searchParams.get('to')
  const fields: Record<string, string> = {}

  let from = utcMidnight(now)
  let to = utcMidnight(now)

  if (rawFrom) {
    const parsedFrom = parseDateParam(rawFrom, 'from')
    if (!parsedFrom.ok) {
      fields.from = parsedFrom.message
    } else {
      from = parsedFrom.value
    }
  }

  if (rawTo) {
    const parsedTo = parseDateParam(rawTo, 'to')
    if (!parsedTo.ok) {
      fields.to = parsedTo.message
    } else {
      to = parsedTo.value
    }
  }

  if (Object.keys(fields).length > 0) {
    return {
      ok: false,
      error: {
        error: 'Invalid date range',
        fields,
      },
    }
  }

  if (!rawFrom && !rawTo) {
    to = utcMidnight(now)
    from = addDays(to, -(DEFAULT_RANGE_DAYS - 1))
  } else if (!rawFrom) {
    from = addDays(to, -(DEFAULT_RANGE_DAYS - 1))
  } else if (!rawTo) {
    to = addDays(from, DEFAULT_RANGE_DAYS - 1)
  }

  if (from.getTime() > to.getTime()) {
    return {
      ok: false,
      error: {
        error: 'Invalid date range',
        fields: {
          from: 'from must be on or before to',
          to: 'to must be on or after from',
        },
      },
    }
  }

  const days = Math.floor((to.getTime() - from.getTime()) / DAY_IN_MS) + 1
  if (days > MAX_RANGE_DAYS) {
    return {
      ok: false,
      error: {
        error: 'Invalid date range',
        fields: {
          from: `date range cannot exceed ${MAX_RANGE_DAYS} days`,
          to: `date range cannot exceed ${MAX_RANGE_DAYS} days`,
        },
      },
    }
  }

  return {
    ok: true,
    value: {
      from,
      to,
      toExclusive: addDays(to, 1),
      days,
    },
  }
}
