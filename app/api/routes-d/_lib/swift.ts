export function validateSWIFT(swift: string): boolean {
  const normalized = swift.replace(/\s/g, '').toUpperCase();

  if (normalized.length !== 8 && normalized.length !== 11) {
    return false;
  }

  if (!/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(normalized)) {
    return false;
  }

  return true;
}
