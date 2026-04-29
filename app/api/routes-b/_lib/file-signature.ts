const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const

export function getMaxFileSize(): number {
  return 2 * 1024 * 1024
}

export function sniffMimeType(buffer: ArrayBuffer): (typeof ALLOWED_MIME_TYPES)[number] | null {
  const bytes = new Uint8Array(buffer)
  if (bytes.length >= 8) {
    const isPng =
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    if (isPng) return 'image/png'
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }

  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp'
  }

  return null
}

export function isAllowedMimeType(mimeType: string): boolean {
  return ALLOWED_MIME_TYPES.includes(mimeType as (typeof ALLOWED_MIME_TYPES)[number])
}

export function stripExifMetadata(buffer: ArrayBuffer, mimeType: string): ArrayBuffer {
  if (mimeType !== 'image/jpeg') return buffer

  const src = new Uint8Array(buffer)
  if (src.length < 4 || src[0] !== 0xff || src[1] !== 0xd8) return buffer

  const out: number[] = [0xff, 0xd8]
  let i = 2

  while (i < src.length) {
    if (src[i] !== 0xff) {
      out.push(src[i])
      i += 1
      continue
    }

    const marker = src[i + 1]
    if (marker === undefined) break

    if (marker === 0xd9 || marker === 0xda) {
      for (let j = i; j < src.length; j += 1) out.push(src[j])
      break
    }

    if (i + 3 >= src.length) break
    const length = (src[i + 2] << 8) | src[i + 3]
    if (length < 2 || i + 2 + length > src.length) break

    const isApp1 = marker === 0xe1
    if (!isApp1) {
      for (let j = i; j < i + 2 + length; j += 1) out.push(src[j])
    }

    i += 2 + length
  }

  return new Uint8Array(out).buffer
}
