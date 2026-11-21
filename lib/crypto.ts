import crypto from 'crypto'

/**
 * Thrown when ciphertext cannot be decrypted: malformed envelope, unknown
 * version prefix, invalid hex/length fields, wrong key, or a failed
 * authentication check. Callers that store user-supplied or legacy secrets
 * should catch this and treat the secret as misconfigured rather than
 * passing the raw ciphertext downstream.
 *
 * Behaviour change: `decrypt` previously returned its input unchanged when
 * the `iv:ciphertext` separator was missing, which let corrupted or
 * plaintext secrets flow into callers (e.g. speakeasy TOTP) undetected.
 * Malformed input now throws `DecryptionError` instead.
 */
export class DecryptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DecryptionError'
  }
}

const ALGORITHM_V2 = 'aes-256-gcm'
const ALGORITHM_LEGACY = 'aes-256-cbc'
const V2_PREFIX = 'v2:'
const NONCE_LENGTH = 12
const IV_LENGTH = 16
const AUTH_TAG_LENGTH = 16
const HEX_RE = /^[0-9a-fA-F]+$/

// Development-only fallback kept for local/test environments so existing
// ciphertext encrypted before ENCRYPTION_KEY was configured remains readable.
// Never used when NODE_ENV=production — see resolveSecretKey().
const DEV_FALLBACK_SECRET = 'default_secret_key_must_be_32_bytes!'

let warnedAboutFallback = false

function resolveSecretKey(): string {
  const configured = process.env.ENCRYPTION_KEY
  if (configured) return configured
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'ENCRYPTION_KEY is not set; refusing to fall back to an insecure key in production'
    )
  }
  if (!warnedAboutFallback) {
    warnedAboutFallback = true
    console.warn(
      'ENCRYPTION_KEY is not set; using an insecure development-only fallback key'
    )
  }
  return DEV_FALLBACK_SECRET
}

function getKey(): Buffer {
  return crypto.createHash('sha256').update(resolveSecretKey()).digest()
}

function parseHexField(value: string, expectedLength: number, field: string): Buffer {
  if (!HEX_RE.test(value)) {
    throw new DecryptionError(`Malformed ${field}: not valid hex`)
  }
  const buf = Buffer.from(value, 'hex')
  if (expectedLength > 0 && buf.length !== expectedLength) {
    throw new DecryptionError(
      `Malformed ${field}: expected ${expectedLength} bytes, got ${buf.length}`
    )
  }
  if (buf.length === 0) {
    throw new DecryptionError(`Malformed ${field}: empty`)
  }
  return buf
}

/**
 * Envelope formats produced by `encrypt`:
 *
 *   v2 (current): `v2:<nonce_hex>:<ciphertext_hex>:<auth_tag_hex>`
 *     aes-256-gcm, 12-byte random nonce, 16-byte GCM auth tag.
 *
 *   legacy (read-only): `<iv_hex>:<ciphertext_hex>`
 *     aes-256-cbc, 16-byte IV, no MAC. `decrypt` still accepts this format so
 *     rows written before the v2 migration remain readable; the next `encrypt`
 *     call rewrites them in the v2 envelope.
 *
 * Key material is `sha256(ENCRYPTION_KEY)`. ENCRYPTION_KEY is required in
 * production (32+ bytes of random entropy recommended, e.g.
 * `openssl rand -base64 32`); outside production a development-only fallback
 * is used with a one-time warning.
 */
export function encrypt(text: string): string {
  if (!text) return text
  const nonce = crypto.randomBytes(NONCE_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM_V2, getKey(), nonce)
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${V2_PREFIX}${nonce.toString('hex')}:${encrypted.toString('hex')}:${tag.toString('hex')}`
}

export function decrypt(text: string): string {
  if (!text) return text
  try {
    if (text.startsWith(V2_PREFIX)) {
      return decryptV2(text)
    }
    if (/^v\d+:/.test(text)) {
      throw new DecryptionError(
        `Unsupported ciphertext version prefix: ${text.slice(0, text.indexOf(':') + 1)}`
      )
    }
    return decryptLegacyCbc(text)
  } catch (error) {
    if (error instanceof DecryptionError) throw error
    throw new DecryptionError(
      `Decryption failed: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function decryptV2(text: string): string {
  const parts = text.slice(V2_PREFIX.length).split(':')
  if (parts.length !== 3) {
    throw new DecryptionError('Malformed v2 ciphertext: expected nonce:data:tag')
  }
  const nonce = parseHexField(parts[0], NONCE_LENGTH, 'nonce')
  const data = parseHexField(parts[1], 0, 'ciphertext')
  const tag = parseHexField(parts[2], AUTH_TAG_LENGTH, 'auth tag')

  const decipher = crypto.createDecipheriv(ALGORITHM_V2, getKey(), nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

function decryptLegacyCbc(text: string): string {
  const parts = text.split(':')
  if (parts.length !== 2) {
    throw new DecryptionError('Malformed ciphertext: expected iv:ciphertext')
  }
  const iv = parseHexField(parts[0], IV_LENGTH, 'IV')
  const data = parseHexField(parts[1], 0, 'ciphertext')

  const decipher = crypto.createDecipheriv(ALGORITHM_LEGACY, getKey(), iv)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

export function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

export function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
