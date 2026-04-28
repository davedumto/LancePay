// File signature validation for common image types
export interface FileSignature {
  magicBytes: number[]
  mimeType: string
  extensions: string[]
}

export const ALLOWED_SIGNATURES: FileSignature[] = [
  // JPEG
  {
    magicBytes: [0xFF, 0xD8, 0xFF],
    mimeType: 'image/jpeg',
    extensions: ['.jpg', '.jpeg']
  },
  // PNG
  {
    magicBytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
    mimeType: 'image/png',
    extensions: ['.png']
  },
  // GIF
  {
    magicBytes: [0x47, 0x49, 0x46, 0x38],
    mimeType: 'image/gif',
    extensions: ['.gif']
  },
  // WebP
  {
    magicBytes: [0x52, 0x49, 0x46, 0x46],
    mimeType: 'image/webp',
    extensions: ['.webp']
  }
]

export function validateFileSignature(buffer: ArrayBuffer): { valid: boolean; mimeType?: string } {
  const bytes = new Uint8Array(buffer)
  
  for (const signature of ALLOWED_SIGNATURES) {
    if (bytes.length >= signature.magicBytes.length) {
      let matches = true
      for (let i = 0; i < signature.magicBytes.length; i++) {
        if (bytes[i] !== signature.magicBytes[i]) {
          matches = false
          break
        }
      }
      if (matches) {
        return { valid: true, mimeType: signature.mimeType }
      }
    }
  }
  
  return { valid: false }
}

export function isAllowedMimeType(mimeType: string): boolean {
  return ALLOWED_SIGNATURES.some(sig => sig.mimeType === mimeType)
}

export function getMaxFileSize(): number {
  // 5MB max file size
  return 5 * 1024 * 1024
}
