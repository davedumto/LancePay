export type CustomHeaders = Record<string, string>

export const MAX_CUSTOM_HEADERS = 10
export const MAX_HEADER_VALUE_LENGTH = 256
export const MAX_HEADER_NAME_LENGTH = 100

const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/
const RESERVED_EXACT = new Set(['host', 'content-length'])
const RESERVED_PREFIX = 'x-lancepay-'

export type HeaderValidationResult =
  | { ok: true; headers: CustomHeaders }
  | { ok: false; error: string }

export function isReservedHeader(name: string): boolean {
  const lower = name.toLowerCase()
  return RESERVED_EXACT.has(lower) || lower.startsWith(RESERVED_PREFIX)
}

export function validateCustomHeaders(input: unknown): HeaderValidationResult {
  if (input === null || input === undefined) {
    return { ok: true, headers: {} }
  }

  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'headers must be an object mapping name to value' }
  }

  const entries = Object.entries(input as Record<string, unknown>)
  if (entries.length > MAX_CUSTOM_HEADERS) {
    return { ok: false, error: `headers may contain at most ${MAX_CUSTOM_HEADERS} entries` }
  }

  const out: CustomHeaders = {}
  const seen = new Set<string>()

  for (const [name, value] of entries) {
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_HEADER_NAME_LENGTH) {
      return { ok: false, error: `header name "${name}" is empty or exceeds ${MAX_HEADER_NAME_LENGTH} characters` }
    }
    if (!HEADER_NAME_PATTERN.test(name)) {
      return { ok: false, error: `header name "${name}" contains invalid characters` }
    }
    if (isReservedHeader(name)) {
      return { ok: false, error: `header "${name}" is reserved and cannot be set` }
    }

    const lower = name.toLowerCase()
    if (seen.has(lower)) {
      return { ok: false, error: `duplicate header "${name}"` }
    }
    seen.add(lower)

    if (typeof value !== 'string') {
      return { ok: false, error: `header "${name}" must have a string value` }
    }
    if (value.length > MAX_HEADER_VALUE_LENGTH) {
      return { ok: false, error: `header "${name}" exceeds ${MAX_HEADER_VALUE_LENGTH} characters` }
    }

    out[name] = value
  }

  return { ok: true, headers: out }
}

const headerStore = new Map<string, CustomHeaders>()

export function setCustomHeaders(webhookId: string, headers: CustomHeaders): void {
  if (Object.keys(headers).length === 0) {
    headerStore.delete(webhookId)
    return
  }
  headerStore.set(webhookId, { ...headers })
}

export function getCustomHeaders(webhookId: string): CustomHeaders {
  const stored = headerStore.get(webhookId)
  return stored ? { ...stored } : {}
}

export function clearCustomHeaders(webhookId: string): void {
  headerStore.delete(webhookId)
}

export function applyCustomHeaders(
  baseHeaders: Record<string, string>,
  custom: CustomHeaders,
): Record<string, string> {
  const merged: Record<string, string> = { ...baseHeaders }
  for (const [name, value] of Object.entries(custom)) {
    if (isReservedHeader(name)) continue
    merged[name] = value
  }
  return merged
}

export function resetCustomHeaderStore(): void {
  headerStore.clear()
}
