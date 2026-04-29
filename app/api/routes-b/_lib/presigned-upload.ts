import { createHash } from 'crypto'
import { sniffMimeType, isAllowedMimeType, getMaxFileSize, stripExifMetadata } from './file-signature'

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

function requireCloudinaryConfig() {
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    throw new Error('Missing Cloudinary configuration')
  }

  return {
    cloudName: CLOUDINARY_CLOUD_NAME,
    apiKey: CLOUDINARY_API_KEY,
    apiSecret: CLOUDINARY_API_SECRET,
  }
}

export function generatePresignedUpload(userId: string): PresignedUploadResponse {
  const config = requireCloudinaryConfig()
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
    allowed_formats: 'jpg,jpeg,png,webp'
  }
  
  // Create signature string
  const signatureString = Object.keys(params)
    .sort()
    .map(key => `${key}=${params[key as keyof typeof params]}`)
    .join('&')
  
  const signature = createHash('sha1')
    .update(signatureString + config.apiSecret)
    .digest('hex')
  
  const expiresAt = new Date(Date.now() + 60 * 1000) // 60 seconds from now
  
  return {
    url: `https://api.cloudinary.com/v1_1/${config.cloudName}/auto/upload`,
    fields: {
      api_key: config.apiKey,
      timestamp: timestamp.toString(),
      public_id: publicId,
      folder,
      signature,
      resource_type: 'auto',
      max_file_size: getMaxFileSize().toString(),
      allowed_formats: 'jpg,jpeg,png,webp'
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
      error: 'File size exceeds 2MiB limit',
      size: buffer.byteLength
    }
  }
  
  // Validate file signature
  const mimeType = sniffMimeType(buffer)
  if (!mimeType) {
    return {
      valid: false,
      error: 'Invalid file type. Only JPEG, PNG, and WebP are allowed'
    }
  }
  
  // Check if MIME type is allowed
  if (!isAllowedMimeType(mimeType)) {
    return {
      valid: false,
      error: 'MIME type not allowed'
    }
  }
  

  const sanitized = stripExifMetadata(buffer, mimeType)

  return {
    valid: true,
    mimeType,
    size: sanitized.byteLength
  }
}

export function generateCloudinaryUrl(key: string): string {
  return `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME || 'demo'}/image/upload/${key}.jpg`
}

export function isExpiredKey(expiresAt: string): boolean {
  return new Date(expiresAt) < new Date()
}
