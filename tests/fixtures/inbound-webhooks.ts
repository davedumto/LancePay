import crypto from 'crypto'
import { signMoonPayWebhook } from '@/lib/moonpay-signature'

/**
 * Shared fixtures for inbound webhook route tests. Each helper returns the
 * signature values together with the secret that produced them, so a test can
 * pass both to the handler under test without duplicating HMAC details.
 */

export const PRIVY_TEST_SECRET = `whsec_${Buffer.from('privy-webhook-test-key').toString('base64')}`
export const MOONPAY_TEST_SECRET = 'moonpay-webhook-test-key'
export const OFFRAMP_TEST_SECRET = 'offramp-webhook-test-key'
export const CIRCLE_TEST_SECRET = 'circle-webhook-test-key'

export function signPrivyWebhook(
  rawBody: string,
  options: { id?: string; timestamp?: string; secret?: string } = {},
) {
  const id = options.id ?? 'evt_test_1'
  const timestamp = options.timestamp ?? '1700000000'
  const secret = options.secret ?? PRIVY_TEST_SECRET
  const signingKey = Buffer.from(
    secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret,
    'base64',
  )
  const signature = crypto
    .createHmac('sha256', signingKey)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest('base64')

  return { id, timestamp, signature: `v1,${signature}`, secret }
}

export function signMoonPayWebhookFixture(
  rawBody: string,
  options: { timestamp?: number; secret?: string } = {},
) {
  const timestamp = options.timestamp ?? 1700000000
  const secret = options.secret ?? MOONPAY_TEST_SECRET
  return { header: signMoonPayWebhook(rawBody, timestamp, secret), timestamp, secret }
}

export function signOfframpWebhook(rawBody: string, secret = OFFRAMP_TEST_SECRET) {
  return {
    signature: crypto.createHmac('sha256', secret).update(rawBody).digest('base64'),
    secret,
  }
}

export function signCircleWebhook(secret = CIRCLE_TEST_SECRET) {
  return { signature: secret, secret }
}
