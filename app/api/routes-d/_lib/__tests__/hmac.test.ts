import { describe, expect, it } from 'vitest'
import { generateWebhookSecret, signWebhookPayload } from '../hmac'

describe('routes-d webhook HMAC helper', () => {
  it('produces a stable HMAC-SHA256 hex signature for a known payload', () => {
    const signature = signWebhookPayload(
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      '1714300800',
      '{"id":"evt_1","type":"invoice.paid"}',
    )
    expect(signature).toBe('83a8b923821be68e43c6b834d852ff285ecb40f9ad240ba0292a8bb371025ded')
    expect(signature).toMatch(/^[0-9a-f]{64}$/)
  })

  it('detects body tampering via signature mismatch', () => {
    const secret = 'a'.repeat(64)
    const timestamp = '1714300800'
    const signature = signWebhookPayload(secret, timestamp, '{"amount":100}')
    const tampered = signWebhookPayload(secret, timestamp, '{"amount":101}')
    expect(tampered).not.toBe(signature)
  })

  it('generates a 64-char hex signing secret', () => {
    const secret = generateWebhookSecret()
    expect(secret).toMatch(/^[0-9a-f]{64}$/)
  })
})
