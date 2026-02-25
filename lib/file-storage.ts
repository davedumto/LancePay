import { mkdir, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { randomBytes } from 'crypto'

const UPLOAD_BASE_DIR = path.join(process.cwd(), 'uploads')
const RECEIPTS_DIR = path.join(UPLOAD_BASE_DIR, 'receipts')
const EXPENSE_RECEIPTS_DIR = path.join(RECEIPTS_DIR, 'expenses')
const BRANDING_LOGOS_DIR = path.join(UPLOAD_BASE_DIR, 'branding-logos')

const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
]

const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.pdf']
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

export interface FileValidationResult {
  valid: boolean
  error?: string
}

/**
 * Validate receipt file for security and format compliance
 */
export function validateReceiptFile(file: File): FileValidationResult {
  if (file.size > MAX_FILE_SIZE) {
    return { valid: false, error: 'File too large (max 10MB)' }
  }

  if (file.size === 0) {
    return { valid: false, error: 'File is empty' }
  }

  if (!ALLOWED_MIME_TYPES.includes(file.type)) {
    return {
      valid: false,
      error: 'Invalid file type. Allowed: JPG, PNG, WEBP, HEIC, PDF',
    }
  }

  const ext = path.extname(file.name).toLowerCase()
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return { valid: false, error: 'Invalid file extension' }
  }

  return { valid: true }
}

/**
 * Validate branding logo file (stricter limits: images only, max 2MB)
 */
export function validateLogoFile(file: File): FileValidationResult {
  const MAX_LOGO_SIZE = 2 * 1024 * 1024 // 2MB

  if (file.size > MAX_LOGO_SIZE) {
    return { valid: false, error: 'File too large (max 2MB)' }
  }

  if (file.size === 0) {
    return { valid: false, error: 'File is empty' }
  }

  if (!file.type.startsWith('image/')) {
    return {
      valid: false,
      error: 'Invalid file type. Logo must be an image (JPG, PNG, WEBP, HEIC)',
    }
  }

  const ext = path.extname(file.name).toLowerCase()
  const allowedLogoExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.heic']
  if (!allowedLogoExtensions.includes(ext)) {
    return { valid: false, error: 'Invalid file extension for logo' }
  }

  return { valid: true }
}

/**
 * Sanitize filename to prevent path traversal and filesystem issues
 */
function sanitizeFilename(filename: string): string {
  // Remove path separators and null bytes
  const clean = filename
    .replace(/[\/\\]/g, '_')
    .replace(/\0/g, '')
    .replace(/\.\./g, '_')

  // Extract extension and basename
  const ext = path.extname(clean)
  const base = path.basename(clean, ext)

  // Keep only alphanumeric, dash, underscore (max 100 chars)
  const safeName = base.replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 100)

  return safeName + ext
}

/**
 * Generate unique filename with timestamp and random suffix
 */
function generateUniqueFilename(originalName: string): string {
  const timestamp = Date.now()
  const randomSuffix = randomBytes(4).toString('hex')
  const ext = path.extname(originalName)
  const basename = path.basename(originalName, ext)
  const sanitized = sanitizeFilename(basename)

  return `${timestamp}_${randomSuffix}_${sanitized}${ext}`
}

/**
 * Store receipt file for an invoice
 * Returns relative path for database storage
 */
export async function storeReceiptFile(
  invoiceId: string,
  file: File
): Promise<string> {
  // Ensure receipts directory exists
  const invoiceDir = path.join(RECEIPTS_DIR, invoiceId)
  if (!existsSync(invoiceDir)) {
    await mkdir(invoiceDir, { recursive: true })
  }

  // Generate safe filename
  const filename = generateUniqueFilename(file.name)
  const filePath = path.join(invoiceDir, filename)

  // Convert File to Buffer
  const arrayBuffer = await file.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)

  // Write file
  await writeFile(filePath, buffer)

  // Return relative path for database
  return `/receipts/${invoiceId}/${filename}`
}

/**
 * Store receipt file for a user expense entry
 * Returns relative path for database storage
 */
export async function storeExpenseReceiptFile(
  userId: string,
  file: File
): Promise<string> {
  const userDir = path.join(EXPENSE_RECEIPTS_DIR, userId)
  if (!existsSync(userDir)) {
    await mkdir(userDir, { recursive: true })
  }

  const filename = generateUniqueFilename(file.name)
  const filePath = path.join(userDir, filename)

  const arrayBuffer = await file.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)

  await writeFile(filePath, buffer)

  return `/receipts/expenses/${userId}/${filename}`
}

/**
 * Store branding logo file for a user.
 * Returns relative path for database storage.
 */
export async function storeBrandingLogoFile(
  userId: string,
  file: File,
): Promise<string> {
  const userDir = path.join(BRANDING_LOGOS_DIR, userId)
  if (!existsSync(userDir)) {
    await mkdir(userDir, { recursive: true })
  }

  const filename = generateUniqueFilename(file.name)
  const filePath = path.join(userDir, filename)

  const arrayBuffer = await file.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)

  await writeFile(filePath, buffer)

  return `/branding-logos/${userId}/${filename}`
}

/**
 * Get absolute path from relative receipt URL
 * Validates path to prevent traversal attacks
 */
export function getReceiptAbsolutePath(receiptUrl: string): string | null {
  // Must start with /receipts/
  if (!receiptUrl.startsWith('/receipts/')) {
    return null
  }

  // Build absolute path
  const absolutePath = path.join(UPLOAD_BASE_DIR, receiptUrl.slice(1))

  // Security: ensure resolved path is within UPLOAD_BASE_DIR
  const normalizedPath = path.normalize(absolutePath)
  if (!normalizedPath.startsWith(UPLOAD_BASE_DIR)) {
    return null
  }

  return normalizedPath
}

/**
 * Get absolute path from relative branding logo URL.
 * Validates path to prevent traversal attacks.
 */
export function getBrandingLogoAbsolutePath(logoUrl: string): string | null {
  if (!logoUrl.startsWith('/branding-logos/')) {
    return null
  }

  const absolutePath = path.join(UPLOAD_BASE_DIR, logoUrl.slice(1))
  const normalizedPath = path.normalize(absolutePath)
  if (!normalizedPath.startsWith(path.normalize(UPLOAD_BASE_DIR))) {
    return null
  }

  return normalizedPath
}
