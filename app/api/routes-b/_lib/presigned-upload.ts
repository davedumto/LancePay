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

export { getMaxFileSize } from './file-signature'

export function generatePresignedUpload(userId: string): PresignedUploadResponse {
  const cloudinaryCloudName = process.env.CLOUDINARY_CLOUD_NAME
  const cloudinaryApiKey = process.env.CLOUDINARY_API_KEY
  const cloudinaryApiSecret = process.env.CLOUDINARY_API_SECRET

  if (!cloudinaryCloudName || !cloudinaryApiKey || !cloudinaryApiSecret) {
    throw new Error('Missing Cloudinary configuration')
  }

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
    .update(signatureString + cloudinaryApiSecret)
    .digest('hex')
  
  const expiresAt = new Date(Date.now() + 60 * 1000) // 60 seconds from now
  
  return {
    url: `https://api.cloudinary.com/v1_1/${cloudinaryCloudName}/auto/upload`,
    fields: {
      api_key: cloudinaryApiKey,
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
      error: `File size exceeds ${getMaxFileSize() === 2 * 1024 * 1024 ? '2MiB' : '5MB'} limit`,
      size: buffer.byteLength
    }
  }
  
  // Validate file signature
  const mimeType = sniffMimeType(buffer)
  if (!mimeType) {
    return {
      valid: false,
      error: 'Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed'
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
  const cloudinaryCloudName = process.env.CLOUDINARY_CLOUD_NAME
  return `https://res.cloudinary.com/${cloudinaryCloudName}/image/upload/${key}.jpg`
}

export function isExpiredKey(expiresAt: string): boolean {
  return new Date(expiresAt) < new Date()
}
