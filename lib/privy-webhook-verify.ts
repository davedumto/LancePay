import crypto from 'crypto'

/**
 * Privy webhook (Svix) signature verification.
 *
 * Svix signs webhooks as `svix-id.svix-timestamp.body` with the webhook
 * secret. In addition to the HMAC check, `svix-timestamp` must be a numeric
 * Unix-seconds value within `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` of the
 * current time. Without this check a captured webhook remains valid forever
 * and can be replayed indefinitely.
 */

/** Maximum allowed clock skew for `svix-timestamp`, in seconds (5 minutes). */
export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300

type SvixHeaders = {
  id: string | null
  timestamp: string | null
  signature: string | null
}

function getSvixSigningKey(secret: string): Buffer {
  const raw = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret
  return Buffer.from(raw, 'base64')
}

function isTimestampFresh(timestamp: string): boolean {
  if (!/^\d+$/.test(timestamp)) return false
  const sentAt = Number(timestamp)
  if (!Number.isFinite(sentAt)) return false
  const nowSeconds = Math.floor(Date.now() / 1000)
  return Math.abs(nowSeconds - sentAt) <= WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS
}

export function verifyPrivyWebhookSignature(
  rawBody: string,
  headers: SvixHeaders,
  secret: string,
): boolean {
  if (!secret || !headers.id || !headers.timestamp || !headers.signature) {
    return false
  }

  if (!isTimestampFresh(headers.timestamp)) {
    return false
  }

  const signedContent = `${headers.id}.${headers.timestamp}.${rawBody}`
  const key = getSvixSigningKey(secret)
  const expected = crypto.createHmac('sha256', key).update(signedContent).digest('base64')

  for (const part of headers.signature.split(' ')) {
    const comma = part.indexOf(',')
    if (comma === -1) continue
    const version = part.slice(0, comma)
    const sig = part.slice(comma + 1)
    if (version !== 'v1' || !sig) continue
    try {
      const sigBuf = Buffer.from(sig, 'base64')
      const expectedBuf = Buffer.from(expected, 'base64')
      if (sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf)) {
        return true
      }
    } catch {
      try {
        if (crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
          return true
        }
      } catch {
        continue
      }
    }
  }

  return false
}
