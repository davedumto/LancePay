import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { timingSafeEqual } from '@/lib/crypto'
import { verifyMoonPaySignatureV2 } from '@/lib/moonpay-signature'
import { verifyPrivyWebhookSignature } from '@/lib/privy-webhook-verify'
import {
  CIRCLE_TEST_SECRET,
  signCircleWebhook,
  signMoonPayWebhookFixture,
  signOfframpWebhook,
  signPrivyWebhook,
} from '../fixtures/inbound-webhooks'

describe('inbound webhook signature fixtures (#1910)', () => {
  it('produces a Privy signature the verifier accepts, and rejects a changed body', () => {
    const rawBody = JSON.stringify({ type: 'user.created' })
    const fixture = signPrivyWebhook(rawBody)

    expect(
      verifyPrivyWebhookSignature(
        rawBody,
        { id: fixture.id, timestamp: fixture.timestamp, signature: fixture.signature },
        fixture.secret,
      ),
    ).toBe(true)
    expect(
      verifyPrivyWebhookSignature(
        `${rawBody } `,
        { id: fixture.id, timestamp: fixture.timestamp, signature: fixture.signature },
        fixture.secret,
      ),
    ).toBe(false)
    expect(
      verifyPrivyWebhookSignature(
        rawBody,
        { id: fixture.id, timestamp: fixture.timestamp, signature: fixture.signature },
        'whsec_d3Jvbmcta2V5',
      ),
    ).toBe(false)
  })

  it('produces a MoonPay signature within the replay window, and rejects stale timestamps', () => {
    const rawBody = JSON.stringify({ type: 'transaction_completed' })
    const now = 1700000000
    const fixture = signMoonPayWebhookFixture(rawBody, { timestamp: now })

    expect(verifyMoonPaySignatureV2(rawBody, fixture.header, fixture.secret, 300, now)).toBe(true)
    expect(verifyMoonPaySignatureV2(rawBody, fixture.header, fixture.secret, 300, now + 301)).toBe(false)
    expect(verifyMoonPaySignatureV2('{}', fixture.header, fixture.secret, 300, now)).toBe(false)
  })

  it('produces an Offramp signature matching the constant-time comparison', () => {
    const rawBody = JSON.stringify({ reference: 'with-1', status: 'completed' })
    const fixture = signOfframpWebhook(rawBody)

    expect(fixture.signature).toMatch(/^[A-Za-z0-9+/=]+$/)
    expect(timingSafeEqual(fixture.signature, fixture.signature)).toBe(true)
    expect(timingSafeEqual(fixture.signature, signOfframpWebhook('{}').signature)).toBe(false)
  })

  it('produces the Circle shared-secret header value', () => {
    const fixture = signCircleWebhook()
    expect(fixture.signature).toBe(CIRCLE_TEST_SECRET)
    expect(fixture.signature).not.toBe(signCircleWebhook('rotated-secret').signature)
  })
})

describe('inbound webhook documentation (#1910)', () => {
  it('documents each provider, its headers and its secret variable, and is linked from DEVOPS', () => {
    const doc = readFileSync(resolve(process.cwd(), 'docs/WEBHOOKS_INBOUND.md'), 'utf8')
    for (const value of [
      'svix-signature',
      'PRIVY_WEBHOOK_SECRET',
      'moonpay-signature-v2',
      'MOONPAY_WEBHOOK_KEY',
      'x-yc-signature',
      'OFFRAMP_WEBHOOK_SECRET',
      'x-circle-signature',
      'CIRCLE_WEBHOOK_SECRET',
      'tests/fixtures/inbound-webhooks.ts',
    ]) {
      expect(doc).toContain(value)
    }

    const devops = readFileSync(resolve(process.cwd(), 'docs/DEVOPS.md'), 'utf8')
    expect(devops).toContain('[Inbound Webhooks](WEBHOOKS_INBOUND.md)')
  })
})
