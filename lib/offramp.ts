import crypto from 'crypto'

/**
 * Default request timeout for off-ramp API calls. A hung provider request
 * must not tie up the withdrawal flow until the platform timeout; override
 * with OFFRAMP_API_TIMEOUT_MS.
 */
const DEFAULT_OFFRAMP_TIMEOUT_MS = 15_000

function offrampTimeoutMs(): number {
  const raw = process.env.OFFRAMP_API_TIMEOUT_MS
  if (!raw) return DEFAULT_OFFRAMP_TIMEOUT_MS
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_OFFRAMP_TIMEOUT_MS
}

/**
 * Base error for off-ramp provider failures. Carries the HTTP status when
 * the provider responded.
 */
export class OfframpError extends Error {
  readonly httpStatus?: number

  constructor(message: string, httpStatus?: number) {
    super(message)
    this.name = 'OfframpError'
    this.httpStatus = httpStatus
  }
}

/**
 * The off-ramp request timed out or the connection dropped before a
 * definitive response. The payout outcome is UNKNOWN — the provider may
 * have accepted it. Callers must look up the withdrawal status (see
 * getOfframpWithdrawalStatus) before retrying; a blind retry can create a
 * second bank payout for the same reference.
 */
export class OfframpUnknownOutcomeError extends OfframpError {
  readonly outcome = 'unknown' as const

  constructor(message: string) {
    super(message)
    this.name = 'OfframpUnknownOutcomeError'
  }
}

function offrampConfig() {
  const apiKey = process.env.OFFRAMP_API_KEY
  const apiSecret = process.env.OFFRAMP_API_SECRET
  const apiUrl = process.env.OFFRAMP_API_URL

  if (!apiKey || !apiSecret || !apiUrl) {
    throw new Error('Off-ramp API configuration missing')
  }
  return { apiKey, apiSecret, apiUrl }
}

function signRequest(apiSecret: string, timestamp: string, payload: string) {
  // Standard HMAC-SHA256 signature for security
  // We sign (timestamp + body) to prevent replay attacks if the API checks the timestamp
  return crypto
    .createHmac('sha256', apiSecret)
    .update(timestamp + payload)
    .digest('hex')
}

function offrampHeaders(apiKey: string, apiSecret: string, signedPayload: string) {
  const timestamp = Date.now().toString()
  return {
    'Content-Type': 'application/json',
    'X-Offramp-API-Key': apiKey,
    'X-Offramp-Timestamp': timestamp,
    'X-Offramp-Signature': signRequest(apiSecret, timestamp, signedPayload),
  }
}

/**
 * Initiates an off-ramp withdrawal through the custom off-ramp API.
 * Signs the request using the API key and secret.
 *
 * Idempotency: `params.reference` is sent as the `Idempotency-Key` header.
 * The provider is expected to deduplicate withdrawals by this key, so a
 * caller retry with the same reference returns the original payout instead
 * of creating a second one.
 *
 * Timeout: the request aborts after OFFRAMP_API_TIMEOUT_MS (default 15s)
 * and throws OfframpUnknownOutcomeError — the outcome is unknown and a
 * status lookup is required before any retry.
 */
export async function initiateOfframp(params: {
  amount: number          // USDC amount
  reference: string       // unique withdrawal ID, sent as Idempotency-Key
  bankAccount: {
    accountNumber: string
    bankCode: string
    accountName: string
  }
}): Promise<{ transactionId: string; status: string }> {
  const { apiKey, apiSecret, apiUrl } = offrampConfig()

  const payload = JSON.stringify(params)

  let response: Response
  try {
    response = await fetch(`${apiUrl}/withdrawals`, {
      method: 'POST',
      headers: {
        ...offrampHeaders(apiKey, apiSecret, payload),
        'Idempotency-Key': params.reference,
      },
      body: payload,
      signal: AbortSignal.timeout(offrampTimeoutMs()),
    })
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'TimeoutError' || error.name === 'AbortError')
    ) {
      throw new OfframpUnknownOutcomeError(
        `Off-ramp request timed out after ${offrampTimeoutMs()}ms; outcome unknown — look up the withdrawal status before retrying`,
      )
    }
    throw error
  }

  // The provider may return a non-JSON error body (proxy/gateway pages);
  // never let response.json() mask the HTTP status.
  const responseData = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >

  if (!response.ok) {
    const message =
      (typeof responseData.error === 'string' && responseData.error) ||
      (typeof responseData.message === 'string' && responseData.message) ||
      'Off-ramp API error'
    throw new OfframpError(message, response.status)
  }

  return {
    transactionId: String(responseData.transactionId ?? ''),
    status: typeof responseData.status === 'string' ? responseData.status : 'pending',
  }
}

/**
 * Look up the status of a previously initiated off-ramp withdrawal by its
 * reference (the same value sent as Idempotency-Key). Required after an
 * OfframpUnknownOutcomeError before deciding whether to retry.
 *
 * Returns null when the provider has no record of the reference.
 */
export async function getOfframpWithdrawalStatus(
  reference: string,
): Promise<{ transactionId?: string; status?: string } | null> {
  const { apiKey, apiSecret, apiUrl } = offrampConfig()

  let response: Response
  try {
    response = await fetch(
      `${apiUrl}/withdrawals/${encodeURIComponent(reference)}`,
      {
        method: 'GET',
        headers: offrampHeaders(apiKey, apiSecret, reference),
        signal: AbortSignal.timeout(offrampTimeoutMs()),
      },
    )
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'TimeoutError' || error.name === 'AbortError')
    ) {
      throw new OfframpUnknownOutcomeError(
        `Off-ramp status lookup timed out after ${offrampTimeoutMs()}ms`,
      )
    }
    throw error
  }

  if (response.status === 404) {
    return null
  }

  const responseData = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >

  if (!response.ok) {
    const message =
      (typeof responseData.error === 'string' && responseData.error) ||
      (typeof responseData.message === 'string' && responseData.message) ||
      'Off-ramp status lookup failed'
    throw new OfframpError(message, response.status)
  }

  return {
    transactionId:
      typeof responseData.transactionId === 'string'
        ? responseData.transactionId
        : undefined,
    status: typeof responseData.status === 'string' ? responseData.status : undefined,
  }
}
