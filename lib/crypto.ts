import crypto from 'crypto'

const ALGORITHM = 'aes-256-cbc'
const SECRET_KEY = process.env.ENCRYPTION_KEY || 'default_secret_key_must_be_32_bytes!'
const IV_LENGTH = 16

// Derive a 32-byte key from the secret property
const KEY_BUFFER = crypto.createHash('sha256').update(String(SECRET_KEY)).digest()

export function encrypt(text: string): string {
  if (!text) return text
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, KEY_BUFFER, iv)
  let encrypted = cipher.update(text, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  return iv.toString('hex') + ':' + encrypted
}

export function decrypt(text: string): string {
  if (!text) return text
  const parts = text.split(':')
  if (parts.length !== 2) return text
  const iv = Buffer.from(parts[0], 'hex')
  const encryptedText = Buffer.from(parts[1], 'hex')
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY_BUFFER, iv)
  let decrypted = decipher.update(encryptedText)
  decrypted = Buffer.concat([decrypted, decipher.final()])
  return decrypted.toString('utf8')
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