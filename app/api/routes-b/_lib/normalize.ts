export function normalizeString(s: string): string {
  if (typeof s !== 'string') {
    return s
  }

  return s
    .trim()
    .replace(/\s+/g, ' ')
    .normalize('NFC')
}
