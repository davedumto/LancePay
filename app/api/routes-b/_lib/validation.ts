export type QueryValidationResult =
  | { ok: true; value: string }
  | { ok: false; error: { code: string; message: string } }

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g
const SQL_WILDCARDS = /[%_]/g
const MAX_QUERY_LENGTH = 128
const MIN_QUERY_LENGTH = 2

export function sanitizeSearchQuery(input: string): string {
  return input.replace(CONTROL_CHARS, '').replace(SQL_WILDCARDS, '').trim().slice(0, MAX_QUERY_LENGTH)
}

export function validateSearchQuery(input: string | null): QueryValidationResult {
  const sanitized = sanitizeSearchQuery(input ?? '')

  if (sanitized.length < MIN_QUERY_LENGTH) {
    return {
      ok: false,
      error: {
        code: 'INVALID_QUERY',
        message: `q must be at least ${MIN_QUERY_LENGTH} characters after trimming and sanitization`,
      },
    }
  }

  return { ok: true, value: sanitized }
}
