/**
 * In-process store for invoice share tokens.
 * Tokens are persisted in-memory; for production durability, back with a DB table.
 */
import crypto from 'crypto'

export interface ShareToken {
  token: string
  invoiceId: string
  userId: string
  expiresAt: Date
  revokedAt?: Date
}

// token -> ShareToken
const store = new Map<string, ShareToken>()

const DEFAULT_EXPIRY_DAYS = Number(process.env.SHARE_TOKEN_EXPIRY_DAYS ?? 30)

export function mintShareToken(invoiceId: string, userId: string, expiryDays = DEFAULT_EXPIRY_DAYS): ShareToken {
  const token = crypto.randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000)
  const entry: ShareToken = { token, invoiceId, userId, expiresAt }
  store.set(token, entry)
  return entry
}

export function lookupShareToken(token: string): ShareToken | null {
  return store.get(token) ?? null
}

export function revokeShareToken(token: string, userId: string): boolean {
  const entry = store.get(token)
  if (!entry || entry.userId !== userId) return false
  entry.revokedAt = new Date()
  return true
}

/** For tests only */
export function clearShareTokenStore() {
  store.clear()
}
