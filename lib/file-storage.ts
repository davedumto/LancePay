import { mkdir, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { randomBytes } from 'crypto'

const UPLOAD_BASE_DIR = path.join(process.cwd(), 'uploads')
const RECEIPTS_DIR = path.join(UPLOAD_BASE_DIR, 'receipts')

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
