import crypto from 'crypto'

const DEFAULT_TOLERANCE_SECONDS = 300

type ParsedSignature = { timestamp: number; signature: string }

export function parseMoonPaySignatureV2(header: string): ParsedSignature | null {
  if (!header) return null

  let timestamp: string | undefined
  let signature: string | undefined

  for (const pair of header.split(',')) {
    const [key, value] = pair.trim().split('=')
    if (!key || !value) continue
    if (key === 't') timestamp = value
    if (key === 's') signature = value
  }

  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return null
  return { timestamp: Number(timestamp), signature }
}

export function signMoonPayWebhook(rawBody: string, timestamp: number, secret: string): string {
  const payload = `${timestamp}.${rawBody}`
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex')
  return `t=${timestamp},s=${signature}`
}

export function verifyMoonPaySignatureV2(
  rawBody: string,
  signatureHeader: string,
  secret: string,
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): boolean {
  if (!secret) return false

  const parsed = parseMoonPaySignatureV2(signatureHeader)
  if (!parsed) return false
  if (!Number.isFinite(toleranceSeconds) || toleranceSeconds < 0) return false
  if (Math.abs(nowSeconds - parsed.timestamp) > toleranceSeconds) return false

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${parsed.timestamp}.${rawBody}`)
    .digest('hex')

  const providedBuffer = Buffer.from(parsed.signature, 'utf8')
  const expectedBuffer = Buffer.from(expected, 'utf8')
  if (providedBuffer.length !== expectedBuffer.length) return false
  return crypto.timingSafeEqual(providedBuffer, expectedBuffer)
}
