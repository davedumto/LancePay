import crypto from 'crypto'

type SvixHeaders = {
  id: string | null
  timestamp: string | null
  signature: string | null
}

function getSvixSigningKey(secret: string): Buffer {
  const raw = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret
  return Buffer.from(raw, 'base64')
}

export function verifyPrivyWebhookSignature(
  rawBody: string,
  headers: SvixHeaders,
  secret: string,
): boolean {
  if (!secret || !headers.id || !headers.timestamp || !headers.signature) {
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
