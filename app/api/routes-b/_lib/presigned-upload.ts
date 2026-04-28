import { createHash } from 'crypto'
import { validateFileSignature, isAllowedMimeType, getMaxFileSize } from './file-signature'

export interface PresignedUploadResponse {
  url: string
  fields: Record<string, string>
  key: string
  expiresAt: string
}

export interface UploadValidation {
  valid: boolean
  error?: string
  mimeType?: string
  size?: number
}

const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET

if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
  throw new Error('Missing Cloudinary configuration')
}

export function generatePresignedUpload(userId: string): PresignedUploadResponse {
  const timestamp = Math.round(Date.now() / 1000)
  const publicId = `avatars/${userId}/${timestamp}`
  const folder = 'avatars'
  
  // Generate signature for Cloudinary upload
  const params = {
    timestamp,
    public_id: publicId,
    folder,
    resource_type: 'auto',
    max_file_size: getMaxFileSize(),
    allowed_formats: 'jpg,jpeg,png,gif,webp'
  }
  
  // Create signature string
  const signatureString = Object.keys(params)
    .sort()
    .map(key => `${key}=${params[key as keyof typeof params]}`)
    .join('&')
  
  const signature = createHash('sha1')
    .update(signatureString + CLOUDINARY_API_SECRET)
    .digest('hex')
  
  const expiresAt = new Date(Date.now() + 60 * 1000) // 60 seconds from now
  
  return {
    url: `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/auto/upload`,
    fields: {
      api_key: CLOUDINARY_API_KEY,
      timestamp: timestamp.toString(),
      public_id: publicId,
      folder,
      signature,
      resource_type: 'auto',
      max_file_size: getMaxFileSize().toString(),
      allowed_formats: 'jpg,jpeg,png,gif,webp'
    },
    key: publicId,
    expiresAt: expiresAt.toISOString()
  }
}

export async function validateUploadedFile(key: string, buffer: ArrayBuffer): Promise<UploadValidation> {
  // Check file size
  if (buffer.byteLength > getMaxFileSize()) {
    return {
      valid: false,
      error: 'File size exceeds 5MB limit',
      size: buffer.byteLength
    }
  }
  
  // Validate file signature
  const signatureValidation = validateFileSignature(buffer)
  if (!signatureValidation.valid) {
    return {
      valid: false,
      error: 'Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed'
    }
  }
  
  // Check if MIME type is allowed
  if (!isAllowedMimeType(signatureValidation.mimeType!)) {
    return {
      valid: false,
      error: 'MIME type not allowed'
    }
  }
  
  return {
    valid: true,
    mimeType: signatureValidation.mimeType,
    size: buffer.byteLength
  }
}

export function generateCloudinaryUrl(key: string): string {
  return `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/image/upload/${key}.jpg`
}

export function isExpiredKey(expiresAt: string): boolean {
  return new Date(expiresAt) < new Date()
}
