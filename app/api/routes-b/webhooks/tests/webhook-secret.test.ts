import { describe, it, expect } from 'vitest'
import { generateSecretFingerprint } from '../../_lib/webhook-fingerprint'

describe('Webhook Secret Fingerprint', () => {
  it('should generate consistent fingerprint for the same secret', () => {
    const secret = 'test-secret-123'
    const fingerprint1 = generateSecretFingerprint(secret)
    const fingerprint2 = generateSecretFingerprint(secret)
    
    expect(fingerprint1).toBe(fingerprint2)
    expect(fingerprint1).toMatch(/^[a-f0-9]{4}\.\.\.[a-f0-9]{4}$/)
  })

  it('should generate different fingerprints for different secrets', () => {
    const secret1 = 'test-secret-123'
    const secret2 = 'test-secret-456'
    const fingerprint1 = generateSecretFingerprint(secret1)
    const fingerprint2 = generateSecretFingerprint(secret2)
    
    expect(fingerprint1).not.toBe(fingerprint2)
  })

  it('should generate fingerprints of correct length', () => {
    const secret = 'test-secret-123'
    const fingerprint = generateSecretFingerprint(secret)
    
    expect(fingerprint).toHaveLength(11) // 4 chars + "..." + 4 chars
  })

  it('should handle empty string secret', () => {
    const secret = ''
    const fingerprint = generateSecretFingerprint(secret)
    
    expect(fingerprint).toMatch(/^[a-f0-9]{4}\.\.\.[a-f0-9]{4}$/)
  })

  it('should handle long secrets', () => {
    const secret = 'a'.repeat(1000)
    const fingerprint = generateSecretFingerprint(secret)
    
    expect(fingerprint).toMatch(/^[a-f0-9]{4}\.\.\.[a-f0-9]{4}$/)
    expect(fingerprint).toHaveLength(11)
  })
})
