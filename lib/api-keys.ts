import crypto from 'crypto'

const API_KEY_PREFIX = 'lp_live_'
const KEY_LENGTH = 32 // 32 random bytes = 64 hex chars

/**
 * Generate a new secure API key with lp_live_ prefix
 * Returns: { fullKey: string, keyHint: string, hashedKey: string }
 */
export function generateApiKey(): { fullKey: string; keyHint: string; hashedKey: string } {
  // Generate cryptographically secure random bytes
  const randomBytes = crypto.randomBytes(KEY_LENGTH)
  const randomString = randomBytes.toString('hex')

  const fullKey = `${API_KEY_PREFIX}${randomString}`
  const keyHint = fullKey.substring(0, 10) // "lp_live_ab"
  const hashedKey = hashApiKey(fullKey)

  return { fullKey, keyHint, hashedKey }
}

/**
 * Hash an API key using SHA-256
 */
export function hashApiKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex')
}

/**
 * Verify an API key against stored hash (timing-safe)
 */
export function verifyApiKey(providedKey: string, storedHash: string): boolean {
  const providedHash = hashApiKey(providedKey)

  // Ensure both hashes are same length before comparison
  if (providedHash.length !== storedHash.length) {
    return false
  }

  // Use timing-safe comparison to prevent timing attacks
  const bufA = Buffer.from(providedHash, 'hex')
  const bufB = Buffer.from(storedHash, 'hex')

  return crypto.timingSafeEqual(bufA, bufB)
}

/**
 * Validate API key format (doesn't verify against DB)
 */
export function isValidApiKeyFormat(key: string): boolean {
  if (!key.startsWith(API_KEY_PREFIX)) return false

  const afterPrefix = key.substring(API_KEY_PREFIX.length)

  // Should be 64 hex characters (32 bytes)
  return /^[a-f0-9]{64}$/i.test(afterPrefix)
}
