import crypto from 'crypto'

type EmailChangeToken = {
  token: string
  userId: string
  oldEmail: string
  newEmail: string
  expiresAt: Date
  used: boolean
}

const store = new Map<string, EmailChangeToken>()

export function clearTokenStore(): void {
  store.clear()
}

export function issueToken(userId: string, oldEmail: string, newEmail: string): string {
  // Invalidate any previous pending tokens for this user
  for (const [key, entry] of store.entries()) {
    if (entry.userId === userId && !entry.used) {
      store.delete(key)
    }
  }

  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
  store.set(token, { token, userId, oldEmail, newEmail, expiresAt, used: false })
  return token
}

export type ConsumeResult =
  | { ok: true; newEmail: string }
  | { ok: false; error: 'invalid_token' | 'expired' | 'already_used' | 'user_mismatch' }

export function consumeToken(token: string, userId: string): ConsumeResult {
  const entry = store.get(token)
  if (!entry) return { ok: false, error: 'invalid_token' }
  if (entry.used) return { ok: false, error: 'already_used' }
  if (entry.expiresAt < new Date()) return { ok: false, error: 'expired' }
  if (entry.userId !== userId) return { ok: false, error: 'user_mismatch' }

  store.set(token, { ...entry, used: true })
  return { ok: true, newEmail: entry.newEmail }
}

/** Advance the expiry of an existing token (for testing). */
export function _expireToken(token: string): void {
  const entry = store.get(token)
  if (entry) store.set(token, { ...entry, expiresAt: new Date(0) })
}
