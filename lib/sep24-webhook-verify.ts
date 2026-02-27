import crypto from 'crypto'

const DEFAULT_MAX_AGE_SECONDS = 300

function normalizeHexSignature(signature: string): string {
  const trimmed = signature.trim()
  if (trimmed.startsWith('sha256=')) {
    return trimmed.slice('sha256='.length)
  }
  return trimmed
}

function parseTimestampMs(timestamp: unknown): number | null {
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
    return timestamp > 1e12 ? timestamp : timestamp * 1000
  }

  if (typeof timestamp === 'string') {
    const asNumber = Number(timestamp)
    if (Number.isFinite(asNumber) && timestamp.trim() !== '') {
      return asNumber > 1e12 ? asNumber : asNumber * 1000
    }

    const parsed = Date.parse(timestamp)
    if (!Number.isNaN(parsed)) {
      return parsed
    }
  }

  return null
}

export function verifySEP24Signature(
  payload: string,
  signature: string,
  secret: string,
  maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS
): boolean {
  const normalizedSignature = normalizeHexSignature(signature)
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex')

  if (normalizedSignature.length !== expectedSignature.length) {
    return false
  }

  let signaturesMatch = false
  try {
    signaturesMatch = crypto.timingSafeEqual(
      Buffer.from(normalizedSignature, 'hex'),
      Buffer.from(expectedSignature, 'hex')
    )
  } catch {
    return false
  }

  if (!signaturesMatch) {
    return false
  }

  let parsedPayload: Record<string, unknown>
  try {
    parsedPayload = JSON.parse(payload) as Record<string, unknown>
  } catch {
    return false
  }

  const timestampMs = parseTimestampMs(parsedPayload.timestamp)
  if (!timestampMs) {
    return false
  }

  const ageSeconds = Math.abs(Date.now() - timestampMs) / 1000
  return ageSeconds <= maxAgeSeconds
}

export function getAnchorSecret(anchorId: string): string {
  const key = anchorId.toLowerCase()
  const secretMap: Record<string, string | undefined> = {
    'yellow-card': process.env.YELLOW_CARD_WEBHOOK_SECRET,
    moneygram: process.env.MONEYGRAM_WEBHOOK_SECRET,
  }

  const secret = secretMap[key]
  if (!secret) {
    throw new Error(`No webhook secret configured for anchor: ${anchorId}`)
  }

  return secret
}
