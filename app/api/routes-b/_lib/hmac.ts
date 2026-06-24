import crypto from 'crypto'

export function generateWebhookSecret() {
  return crypto.randomBytes(32).toString('hex')
}

export function signWebhookPayload(secret: string, timestamp: string, body: string) {
  const payloadToSign = `${timestamp}.${body}`
  return crypto.createHmac('sha256', secret).update(payloadToSign).digest('hex')
}

