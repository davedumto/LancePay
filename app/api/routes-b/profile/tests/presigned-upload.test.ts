import { describe, it, expect, beforeEach, vi } from 'vitest'
import { 
  generatePresignedUpload, 
  validateUploadedFile, 
  generateCloudinaryUrl, 
  isExpiredKey,
  getMaxFileSize 
} from '../../_lib/presigned-upload'

// Mock environment variables
const originalEnv = process.env

describe('Presigned Upload', () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      CLOUDINARY_CLOUD_NAME: 'test-cloud',
      CLOUDINARY_API_KEY: 'test-key',
      CLOUDINARY_API_SECRET: 'test-secret'
    }
  })

  it('should generate presigned upload URL', () => {
    const userId = 'user-123'
    const result = generatePresignedUpload(userId)

    expect(result).toMatchObject({
      url: 'https://api.cloudinary.com/v1_1/test-cloud/auto/upload',
      fields: expect.objectContaining({
        api_key: 'test-key',
        folder: 'avatars',
        resource_type: 'auto',
        allowed_formats: 'jpg,jpeg,png,gif,webp'
      }),
      key: expect.stringContaining(`avatars/${userId}/`),
      expiresAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    })

    // Check that the key includes timestamp
    expect(result.key).toMatch(/avatars\/user-123\/\d+/)
    
    // Check that expiration is 60 seconds from now
    const expiresAt = new Date(result.expiresAt)
    const now = new Date()
    const timeDiff = expiresAt.getTime() - now.getTime()
    expect(timeDiff).toBeGreaterThan(50000) // At least 50 seconds
    expect(timeDiff).toBeLessThan(70000) // Less than 70 seconds
  })

  it('should validate uploaded file successfully', async () => {
    // Create a valid JPEG buffer (JPEG magic bytes)
    const jpegBuffer = new ArrayBuffer(10)
    const jpegView = new Uint8Array(jpegBuffer)
    jpegView.set([0xFF, 0xD8, 0xFF, 0xE0]) // JPEG signature

    const result = await validateUploadedFile('test-key', jpegBuffer)

    expect(result.valid).toBe(true)
    expect(result.mimeType).toBe('image/jpeg')
    expect(result.size).toBe(10)
  })

  it('should reject oversized file', async () => {
    const oversizedBuffer = new ArrayBuffer(getMaxFileSize() + 1)

    const result = await validateUploadedFile('test-key', oversizedBuffer)

    expect(result.valid).toBe(false)
    expect(result.error).toBe('File size exceeds 5MB limit')
    expect(result.size).toBe(getMaxFileSize() + 1)
  })

  it('should reject invalid file type', async () => {
    const invalidBuffer = new ArrayBuffer(10)
    const invalidView = new Uint8Array(invalidBuffer)
    invalidView.set([0x00, 0x01, 0x02, 0x03]) // Invalid signature

    const result = await validateUploadedFile('test-key', invalidBuffer)

    expect(result.valid).toBe(false)
    expect(result.error).toBe('Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed')
  })

  it('should generate Cloudinary URL', () => {
    const key = 'avatars/user-123/1234567890'
    const result = generateCloudinaryUrl(key)

    expect(result).toBe('https://res.cloudinary.com/test-cloud/image/upload/avatars/user-123/1234567890.jpg')
  })

  it('should check if key is expired', () => {
    // Test expired key
    const pastDate = new Date(Date.now() - 1000).toISOString() // 1 second ago
    expect(isExpiredKey(pastDate)).toBe(true)

    // Test non-expired key
    const futureDate = new Date(Date.now() + 60000).toISOString() // 1 minute from now
    expect(isExpiredKey(futureDate)).toBe(false)
  })

  it('should handle different image formats', async () => {
    // PNG signature
    const pngBuffer = new ArrayBuffer(10)
    const pngView = new Uint8Array(pngBuffer)
    pngView.set([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])

    const pngResult = await validateUploadedFile('test-key', pngBuffer)
    expect(pngResult.valid).toBe(true)
    expect(pngResult.mimeType).toBe('image/png')

    // GIF signature
    const gifBuffer = new ArrayBuffer(10)
    const gifView = new Uint8Array(gifBuffer)
    gifView.set([0x47, 0x49, 0x46, 0x38])

    const gifResult = await validateUploadedFile('test-key', gifBuffer)
    expect(gifResult.valid).toBe(true)
    expect(gifResult.mimeType).toBe('image/gif')
  })

  it('should throw error for missing Cloudinary config', () => {
    delete process.env.CLOUDINARY_CLOUD_NAME

    expect(() => generatePresignedUpload('user-123')).toThrow('Missing Cloudinary configuration')
  })
})
