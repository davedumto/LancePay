export class BadRequest extends Error {
  readonly field: string
  constructor(field: string, message: string) {
    super(message)
    this.name = 'BadRequest'
    this.field = field
  }
}

/**
 * Coerce a query-param string to boolean.
 * Accepts: true/false, 1/0, yes/no (case-insensitive).
 * Returns defaultValue when raw is null/undefined.
 * Throws BadRequest for any other value.
 */
export function toBool(
  raw: string | null | undefined,
  field: string,
  defaultValue?: boolean,
): boolean {
  if (raw === null || raw === undefined) {
    if (defaultValue !== undefined) return defaultValue
    throw new BadRequest(field, `${field} is required`)
  }
  const lower = raw.toLowerCase()
  if (lower === 'true' || lower === '1' || lower === 'yes') return true
  if (lower === 'false' || lower === '0' || lower === 'no') return false
  throw new BadRequest(field, `${field} must be a boolean (true/false/1/0/yes/no)`)
}

/**
 * Coerce a query-param string to an integer.
 * Throws BadRequest for non-integer strings, out-of-range values, or missing required params.
 */
export function toInt(
  raw: string | null | undefined,
  field: string,
  opts?: { default?: number; min?: number; max?: number },
): number {
  if (raw === null || raw === undefined) {
    if (opts?.default !== undefined) return opts.default
    throw new BadRequest(field, `${field} is required`)
  }
  const trimmed = raw.trim()
  // parseInt is lenient ("10abc" → 10); use Number for strict parsing
  if (!/^-?\d+$/.test(trimmed)) {
    throw new BadRequest(field, `${field} must be an integer`)
  }
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) {
    throw new BadRequest(field, `${field} must be an integer`)
  }
  if (opts?.min !== undefined && parsed < opts.min) {
    throw new BadRequest(field, `${field} must be at least ${opts.min}`)
  }
  if (opts?.max !== undefined && parsed > opts.max) {
    throw new BadRequest(field, `${field} must be at most ${opts.max}`)
  }
  return parsed
}

/**
 * Coerce a comma-separated query-param string to a deduplicated string array.
 * Empty or missing values return the default (or []).
 */
export function toCsvArray(
  raw: string | null | undefined,
  _field: string,
  opts?: { default?: string[] },
): string[] {
  if (raw === null || raw === undefined || raw.trim() === '') {
    return opts?.default ?? []
  }
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean)
  return [...new Set(parts)]
}

/**
 * Coerce a YYYY-MM-DD query-param string to a Date (UTC midnight).
 * Returns opts.default when raw is null/undefined.
 * Throws BadRequest for bad formats or invalid calendar dates.
 */
export function toIsoDate(
  raw: string | null | undefined,
  field: string,
  opts?: { default?: Date },
): Date {
  if (raw === null || raw === undefined) {
    if (opts?.default !== undefined) return opts.default
    throw new BadRequest(field, `${field} is required`)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new BadRequest(field, `${field} must be in YYYY-MM-DD format`)
  }
  const date = new Date(`${raw}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) {
    throw new BadRequest(field, `${field} is not a valid calendar date`)
  }
  return date
}
