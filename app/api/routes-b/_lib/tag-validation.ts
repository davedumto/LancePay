/**
 * tag-validation.ts — Issue #610
 *
 * Reusable tag-name validation helper. Mirrors the rules used elsewhere in
 * the tag router (length 1–32, trimmed, no control characters).
 */

export type TagNameValidation =
  | { ok: true; value: string }
  | { ok: false; error: string };

const MIN_LENGTH = 1;
const MAX_LENGTH = 32;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

export function validateTagName(input: unknown): TagNameValidation {
  if (typeof input !== 'string') {
    return { ok: false, error: 'newName must be a string' };
  }
  const trimmed = input.trim();
  if (trimmed.length < MIN_LENGTH) {
    return { ok: false, error: `newName must be at least ${MIN_LENGTH} character(s)` };
  }
  if (trimmed.length > MAX_LENGTH) {
    return { ok: false, error: `newName must be at most ${MAX_LENGTH} characters` };
  }
  if (CONTROL_CHARS.test(trimmed)) {
    return { ok: false, error: 'newName contains control characters' };
  }
  return { ok: true, value: trimmed };
}
