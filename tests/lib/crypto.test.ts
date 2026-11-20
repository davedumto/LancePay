import crypto from 'crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  decrypt,
  DecryptionError,
  encrypt,
  generateToken,
  hashToken,
  timingSafeEqual,
} from '@/lib/crypto'

const TEST_KEY = 'test-encryption-key-with-enough-entropy-32b'

function deriveKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret).digest()
}

function encryptLegacyCbc(plaintext: string, secret: string = TEST_KEY): string {
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-cbc', deriveKey(secret), iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`
}

describe('lib/crypto', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = TEST_KEY
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    vi.restoreAllMocks()
  })

  it('encrypts and decrypts text values', () => {
    const plaintext = 'secret-wallet-key'
    const encrypted = encrypt(plaintext)

    expect(encrypted).not.toBe(plaintext)
    expect(decrypt(encrypted)).toBe(plaintext)
  })

  it('writes the versioned v2 aes-256-gcm envelope', () => {
    const encrypted = encrypt('secret-wallet-key')
    const parts = encrypted.split(':')

    expect(parts[0]).toBe('v2')
    expect(parts).toHaveLength(4)
    expect(Buffer.from(parts[1], 'hex')).toHaveLength(12) // nonce
    expect(Buffer.from(parts[3], 'hex')).toHaveLength(16) // auth tag
  })

  it('produces a different ciphertext each time (random nonce)', () => {
    expect(encrypt('same-plaintext')).not.toBe(encrypt('same-plaintext'))
  })

  it('returns empty values unchanged for encrypt/decrypt', () => {
    expect(encrypt('')).toBe('')
    expect(decrypt('')).toBe('')
  })

  it('decrypts a legacy aes-256-cbc payload', () => {
    const legacy = encryptLegacyCbc('legacy-secret')
    expect(decrypt(legacy)).toBe('legacy-secret')
  })

  it('re-encrypts decrypted legacy payloads to the v2 envelope on next write', () => {
    const plaintext = decrypt(encryptLegacyCbc('rotate-me'))
    const rewritten = encrypt(plaintext)
    expect(rewritten.startsWith('v2:')).toBe(true)
    expect(decrypt(rewritten)).toBe('rotate-me')
  })

  it('throws DecryptionError for input missing the iv:ciphertext separator', () => {
    expect(() => decrypt('not-a-ciphertext')).toThrow(DecryptionError)
    expect(() => decrypt('plaintext-secret-value')).toThrow(DecryptionError)
  })

  it('throws DecryptionError for an invalid hex IV', () => {
    expect(() => decrypt('zz-not-hex:' + 'aabbcc')).toThrow(DecryptionError)
    expect(() => decrypt('aabb:' + 'zz-not-hex')).toThrow(DecryptionError)
  })

  it('throws DecryptionError for a wrong-length IV', () => {
    expect(() => decrypt('aabbcc:' + 'aabbcc')).toThrow(DecryptionError)
  })

  it('throws DecryptionError when decrypted with the wrong key', () => {
    const encrypted = encrypt('sensitive')
    process.env.ENCRYPTION_KEY = 'a-completely-different-key-value!'
    expect(() => decrypt(encrypted)).toThrow(DecryptionError)
  })

  it('throws DecryptionError when the v2 auth tag is tampered with', () => {
    const parts = encrypt('tamper-me').split(':')
    const tag = Buffer.from(parts[3], 'hex')
    tag[0] = tag[0] ^ 0xff
    parts[3] = tag.toString('hex')
    expect(() => decrypt(parts.join(':'))).toThrow(DecryptionError)
  })

  it('throws DecryptionError for an unknown version prefix', () => {
    expect(() => decrypt('v3:deadbeef:cafebabe:0011')).toThrow(DecryptionError)
  })

  it('throws DecryptionError for a truncated v2 envelope', () => {
    expect(() => decrypt('v2:abcd')).toThrow(DecryptionError)
  })

  it('throws at first use in production when ENCRYPTION_KEY is missing', () => {
    delete process.env.ENCRYPTION_KEY
    process.env.NODE_ENV = 'production'
    expect(() => encrypt('secret')).toThrow(/ENCRYPTION_KEY/)
    const wellFormedV2 = `v2:${'00'.repeat(12)}:${'00'.repeat(16)}:${'00'.repeat(16)}`
    expect(() => decrypt(wellFormedV2)).toThrow(/ENCRYPTION_KEY/)
  })

  it('uses a development fallback with a warning outside production', () => {
    delete process.env.ENCRYPTION_KEY
    process.env.NODE_ENV = 'development'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const encrypted = encrypt('dev-secret')
    expect(encrypted.startsWith('v2:')).toBe(true)
    expect(decrypt(encrypted)).toBe('dev-secret')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ENCRYPTION_KEY'))
  })

  it('reads ciphertext produced under the development fallback key', () => {
    delete process.env.ENCRYPTION_KEY
    process.env.NODE_ENV = 'test'
    const legacy = encryptLegacyCbc('old-dev-secret', 'default_secret_key_must_be_32_bytes!')
    expect(decrypt(legacy)).toBe('old-dev-secret')
  })

  it('compares strings using timing-safe equality', () => {
    expect(timingSafeEqual('abc123', 'abc123')).toBe(true)
    expect(timingSafeEqual('abc123', 'abc124')).toBe(false)
    expect(timingSafeEqual('short', 'longer')).toBe(false)
  })

  it('generates a 32-byte hex token', () => {
    const token = generateToken()
    expect(token).toMatch(/^[a-f0-9]{64}$/)
  })

  it('hashes tokens deterministically', () => {
    const token = 'sample-token'
    expect(hashToken(token)).toBe(hashToken(token))
    expect(hashToken(token)).toMatch(/^[a-f0-9]{64}$/)
  })
})
