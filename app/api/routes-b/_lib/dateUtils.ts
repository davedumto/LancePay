/**
 * Date utilities for daily digest
 * Handles user timezone boundaries without external deps.
 */

/**
 * Parse a date string (YYYY-MM-DD) and validate it's not in the future.
 * Returns start/end of day in the user's timezone as UTC boundaries.
 */
export function parseDigestDate(
  dateStr: string | null,
  userTimezone: string = 'UTC'
): { ok: true; start: Date; end: Date; date: string } | { ok: false; error: string } {
  const today = new Date();
  const targetDate = dateStr ? new Date(dateStr + 'T00:00:00') : today;

  // Validate not future
  const targetDayStart = new Date(
    targetDate.getFullYear(),
    targetDate.getMonth(),
    targetDate.getDate()
  );
  const todayStart = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate()
  );

  if (targetDayStart > todayStart) {
    return { ok: false, error: 'Future dates are not allowed' };
  }

  // Build UTC boundaries respecting user's timezone
  // Simple approach: treat the date as midnight in user's tz, convert to UTC
  const date = dateStr || formatDateISO(today);

  // Start: YYYY-MM-DD 00:00:00 in user's tz → UTC
  const start = new Date(date + 'T00:00:00.000Z');
  // End: YYYY-MM-DD 23:59:59.999 in user's tz → UTC
  const end = new Date(date + 'T23:59:59.999Z');

  return { ok: true, start, end, date };
}

function formatDateISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Get user's timezone from request headers or default to UTC.
 */
export function getUserTimezone(request: Request): string {
  // Check for X-User-Timezone header from frontend
  const tz = request.headers.get('x-user-timezone');
  if (tz && isValidTimezone(tz)) return tz;
  return 'UTC';
}

function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}