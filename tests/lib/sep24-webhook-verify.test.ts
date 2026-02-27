import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { getAnchorSecret, verifySEP24Signature } from '@/lib/sep24-webhook-verify'
import crypto from 'crypto'

function sign(payload: string, secret: string) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex')
}

describe('SEP-24 webhook verification', () => {
  const secret = 'whsec_test_secret'

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-02-26T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    delete process.env.YELLOW_CARD_WEBHOOK_SECRET
    delete process.env.MONEYGRAM_WEBHOOK_SECRET
  })

  it('accepts valid signature with fresh timestamp', () => {
    const payload = JSON.stringify({ id: 'tx_1', status: 'completed', timestamp: Date.now() })
    const signature = sign(payload, secret)

    expect(verifySEP24Signature(payload, signature, secret)).toBe(true)
  })

  it('rejects missing or invalid signature', () => {
    const payload = JSON.stringify({ id: 'tx_1', status: 'completed', timestamp: Date.now() })
    expect(verifySEP24Signature(payload, '', secret)).toBe(false)
    expect(verifySEP24Signature(payload, 'invalid', secret)).toBe(false)
  })

  it('rejects stale timestamp payload', () => {
    const oldTs = Date.now() - 10 * 60 * 1000
    const payload = JSON.stringify({ id: 'tx_2', status: 'failed', timestamp: oldTs })
    const signature = sign(payload, secret)

    expect(verifySEP24Signature(payload, signature, secret)).toBe(false)
  })

  it('resolves anchor-specific secrets', () => {
    process.env.YELLOW_CARD_WEBHOOK_SECRET = 'yellow_secret'
    process.env.MONEYGRAM_WEBHOOK_SECRET = 'mg_secret'

    expect(getAnchorSecret('yellow-card')).toBe('yellow_secret')
    expect(getAnchorSecret('moneygram')).toBe('mg_secret')
  })
})
