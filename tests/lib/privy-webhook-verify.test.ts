import { describe, expect, it } from 'vitest'
import crypto from 'crypto'
import {
  verifyPrivyWebhookSignature,
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
} from '@/lib/privy-webhook-verify'

const SECRET = 'whsec_' + Buffer.from('super-secret-signing-key!!').toString('base64')
const BODY = JSON.stringify({ type: 'user.created', data: { user: { id: 'privy-1' } } })

function sign(body: string, timestamp: string, id = 'msg_123'): string {
  const key = Buffer.from(SECRET.slice('whsec_'.length), 'base64')
  const signedContent = `${id}.${timestamp}.${body}`
  return 'v1,' + crypto.createHmac('sha256', key).update(signedContent).digest('base64')
}

function nowSeconds(): string {
  return Math.floor(Date.now() / 1000).toString()
}

describe('verifyPrivyWebhookSignature timestamp tolerance (#1839)', () => {
  it('accepts a fresh timestamp with a valid signature', () => {
    const timestamp = nowSeconds()
    expect(
      verifyPrivyWebhookSignature(BODY, { id: 'msg_1', timestamp, signature: sign(BODY, timestamp, 'msg_1') }, SECRET)
    ).toBe(true)
  })

  it('rejects a stale timestamp even with a valid signature', () => {
    const timestamp = (Math.floor(Date.now() / 1000) - WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS - 60).toString()
    expect(
      verifyPrivyWebhookSignature(BODY, { id: 'msg_1', timestamp, signature: sign(BODY, timestamp, 'msg_1') }, SECRET)
    ).toBe(false)
  })

  it('rejects a future timestamp beyond the tolerance', () => {
    const timestamp = (Math.floor(Date.now() / 1000) + WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS + 60).toString()
    expect(
      verifyPrivyWebhookSignature(BODY, { id: 'msg_1', timestamp, signature: sign(BODY, timestamp, 'msg_1') }, SECRET)
    ).toBe(false)
  })

  it('rejects malformed and non-numeric timestamps', () => {
    for (const timestamp of ['not-a-number', '1700000000.5', '', '0x10', '  123  ']) {
      expect(
        verifyPrivyWebhookSignature(BODY, { id: 'msg_1', timestamp, signature: sign(BODY, timestamp, 'msg_1') }, SECRET)
      ).toBe(false)
    }
  })

  it('still rejects a bad signature on a fresh timestamp', () => {
    const timestamp = nowSeconds()
    expect(
      verifyPrivyWebhookSignature(BODY, { id: 'msg_1', timestamp, signature: 'v1,AAAA' }, SECRET)
    ).toBe(false)
  })

  it('rejects missing headers or secret', () => {
    const timestamp = nowSeconds()
    const signature = sign(BODY, timestamp)
    expect(verifyPrivyWebhookSignature(BODY, { id: null, timestamp, signature }, SECRET)).toBe(false)
    expect(verifyPrivyWebhookSignature(BODY, { id: 'm', timestamp: null, signature }, SECRET)).toBe(false)
    expect(verifyPrivyWebhookSignature(BODY, { id: 'm', timestamp, signature: null }, SECRET)).toBe(false)
    expect(verifyPrivyWebhookSignature(BODY, { id: 'm', timestamp, signature }, '')).toBe(false)
  })
})
