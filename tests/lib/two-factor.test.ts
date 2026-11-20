import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import speakeasy from 'speakeasy'
import { encrypt } from '@/lib/crypto'
import { verifyTwoFactorForRequest } from '@/lib/two-factor'

const BASE32_SECRET = 'JBSWY3DPEHPK3PXP'

function currentToken(): string {
  return speakeasy.totp({ secret: BASE32_SECRET, encoding: 'base32' })
}

describe('verifyTwoFactorForRequest', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = 'test-encryption-key-with-enough-entropy-32b'
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('returns ok when 2FA is disabled', () => {
    expect(
      verifyTwoFactorForRequest({ twoFactorEnabled: false, twoFactorSecret: null }, undefined)
    ).toEqual({ ok: true })
  })

  it('requires a code when 2FA is enabled', () => {
    const result = verifyTwoFactorForRequest(
      { twoFactorEnabled: true, twoFactorSecret: encrypt(BASE32_SECRET) },
      undefined
    )
    expect(result).toEqual({ ok: false, status: 401, error: '2FA code required' })
  })

  it('verifies a valid TOTP code against the decrypted secret', () => {
    const result = verifyTwoFactorForRequest(
      { twoFactorEnabled: true, twoFactorSecret: encrypt(BASE32_SECRET) },
      currentToken()
    )
    expect(result).toEqual({ ok: true })
  })

  it('rejects an invalid TOTP code', () => {
    const result = verifyTwoFactorForRequest(
      { twoFactorEnabled: true, twoFactorSecret: encrypt(BASE32_SECRET) },
      '000000'
    )
    expect(result).toEqual({ ok: false, status: 401, error: 'Invalid 2FA code' })
  })

  it('returns the misconfigured response when the stored secret is missing', () => {
    const result = verifyTwoFactorForRequest(
      { twoFactorEnabled: true, twoFactorSecret: null },
      '123456'
    )
    expect(result).toEqual({ ok: false, status: 401, error: '2FA is misconfigured; contact support' })
  })

  it('returns the misconfigured response when the stored secret cannot be decrypted', () => {
    const result = verifyTwoFactorForRequest(
      { twoFactorEnabled: true, twoFactorSecret: 'corrupted-plaintext-secret' },
      '123456'
    )
    expect(result).toEqual({ ok: false, status: 401, error: '2FA is misconfigured; contact support' })
  })

  it('returns the misconfigured response for a tampered ciphertext', () => {
    const parts = encrypt(BASE32_SECRET).split(':')
    parts[3] = '00'.repeat(16)
    const result = verifyTwoFactorForRequest(
      { twoFactorEnabled: true, twoFactorSecret: parts.join(':') },
      '123456'
    )
    expect(result).toEqual({ ok: false, status: 401, error: '2FA is misconfigured; contact support' })
  })
})
