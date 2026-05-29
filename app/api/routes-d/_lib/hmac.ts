import crypto from 'crypto'

export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString('hex')
}

/**
 * HMAC-SHA256 over `{timestamp}.{body}` using the webhook signing secret.
 */
export function signWebhookPayload(secret: string, timestamp: string, body: string): string {
  const payloadToSign = `${timestamp}.${body}`
  return crypto.createHmac('sha256', secret).update(payloadToSign).digest('hex')
}
