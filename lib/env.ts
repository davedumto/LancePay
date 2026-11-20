/**
 * Validated numeric environment variables.
 *
 * `parseInt`/`Number` on env vars silently produce NaN for values like "5d"
 * or "", which then poisons every calculation downstream (SLA deadlines,
 * cooldowns, compliance thresholds). Always read numeric config through
 * `envNumber` so invalid input falls back to the default with a warning.
 */

export interface EnvNumberOptions {
  /** Require an integer value (rejects 1.5). Default false. */
  integer?: boolean
  /**
   * Exclusive lower bound. Default 0 — values must be > 0 unless
   * `allowZero` is set. Pass a negative number to allow negatives.
   */
  min?: number
  /** Allow the value to equal `min`. Default false. */
  allowZero?: boolean
}

/**
 * Parses a numeric env var. Returns `fallback` when the variable is unset
 * or empty; returns `fallback` with a console warning when the value is
 * set but not a finite number (and not an integer when `integer: true`)
 * within the allowed range.
 *
 * Accepted format: a plain decimal number, e.g. `"432000000"`, `"1.5"`.
 * Units suffixes like `"5d"` are rejected.
 */
export function envNumber(
  name: string,
  fallback: number,
  options: EnvNumberOptions = {},
): number {
  const { integer = false, min = 0, allowZero = false } = options
  const raw = process.env[name]

  if (raw === undefined || raw.trim() === '') {
    return fallback
  }

  const value = Number(raw)
  const inRange = allowZero ? value >= min : value > min
  const valid =
    Number.isFinite(value) &&
    inRange &&
    (!integer || Number.isInteger(value)) &&
    Number.isFinite(fallback)

  if (!valid) {
    console.warn(
      `[env] ${name}="${raw}" is not a valid ${integer ? 'integer' : 'number'} ` +
        `(expected > ${min}${allowZero ? ' or equal' : ''}); using default ${fallback}`,
    )
    return fallback
  }

  return value
}
