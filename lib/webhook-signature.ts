import { createHmac, timingSafeEqual } from 'crypto'

/**
 * Shared helpers for computing and verifying outbound webhook signatures.
 *
 * Outbound deliveries are signed with HMAC-SHA256 over the exact serialized
 * payload string that is sent in the request body. The signature is encoded as
 * lowercase hex and transmitted with a scheme prefix (`sha256=<hex>`), matching
 * the convention used by common providers (Stripe, GitHub). Keeping the
 * algorithm in one place guarantees the audit `verify-signature` endpoint
 * recomputes signatures the same way the delivery pipeline produced them.
 */

export const WEBHOOK_SIGNATURE_PREFIX = 'sha256='

/**
 * Compute the signature for a payload using a webhook signing secret.
 * Returns the value in `sha256=<hex>` form.
 */
export function computeWebhookSignature(payload: string, secret: string): string {
  const digest = createHmac('sha256', secret).update(payload, 'utf8').digest('hex')
  return `${WEBHOOK_SIGNATURE_PREFIX}${digest}`
}

/**
 * Constant-time comparison of two signature strings.
 *
 * Uses `crypto.timingSafeEqual` so the comparison does not leak information via
 * timing. Inputs of differing byte length short-circuit to `false` (which is
 * itself constant-time relative to the secret, since length is not secret).
 */
export function signaturesMatch(expected: string, provided: string): boolean {
  const expectedBuf = Buffer.from(expected, 'utf8')
  const providedBuf = Buffer.from(provided, 'utf8')
  if (expectedBuf.length !== providedBuf.length) return false
  return timingSafeEqual(expectedBuf, providedBuf)
}
