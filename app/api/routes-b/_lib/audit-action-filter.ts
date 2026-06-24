/**
 * audit-action-filter.ts — Issue #621
 *
 * Validates and builds the Prisma `where` clause for the audit-log
 * `?action=...` (exact match) and `?actionPrefix=...` (prefix match)
 * query parameters. Both compose with existing filters via AND.
 */

const PREFIX_MIN = 2;
const PREFIX_MAX = 64;

export type ActionFilterResult =
  | { ok: true; clause: { eventType?: { equals?: string; startsWith?: string } } }
  | { ok: false; error: string };

/**
 * Build a Prisma `eventType` filter clause from URL search params.
 *
 * - When both `action` and `actionPrefix` are missing → returns `{}` (no filter).
 * - When `action` is present → `{ eventType: { equals: action } }`.
 * - When `actionPrefix` is present → validates length [2, 64]; returns
 *   `{ eventType: { startsWith: actionPrefix } }`.
 * - When `actionPrefix` is invalid → returns `{ ok: false, error }`.
 *
 * If both are provided, `action` (exact) takes precedence — the more
 * specific filter wins.
 */
export function buildActionFilter(
  searchParams: URLSearchParams,
): ActionFilterResult {
  const action = searchParams.get('action')?.trim();
  const actionPrefix = searchParams.get('actionPrefix')?.trim();

  if (action) {
    return { ok: true, clause: { eventType: { equals: action } } };
  }

  if (!actionPrefix) {
    return { ok: true, clause: {} };
  }

  if (actionPrefix.length < PREFIX_MIN || actionPrefix.length > PREFIX_MAX) {
    return {
      ok: false,
      error: `actionPrefix must be between ${PREFIX_MIN} and ${PREFIX_MAX} characters`,
    };
  }

  return { ok: true, clause: { eventType: { startsWith: actionPrefix } } };
}
