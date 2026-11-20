import crypto from 'crypto'

/**
 * Webhook delivery retry configuration.
 * Exponential backoff with jitter to prevent thundering herd.
 */
export const WEBHOOK_RETRY_CONFIG = {
  baseDelayMs: 5000, // 5 seconds initial delay
  maxDelayMs: 86400000, // 24 hours max delay
  backoffFactor: 2,
  jitterMs: 1000, // 0-1000ms random jitter
  consecutiveFailuresThreshold: 10, // Disable webhook after this many consecutive failures
  maxAttempts: 15, // Prevent infinite retries (dead-letter after this)
}

/**
 * Compute next retry delay using exponential backoff.
 * Formula: min(baseDelayMs * 2^(attemptCount), maxDelayMs) + jitter
 * @param attemptCount Current attempt count (0-indexed)
 * @returns Delay in milliseconds before next retry
 */
export function computeNextRetryDelayMs(attemptCount: number): number {
  const exponential = Math.min(
    WEBHOOK_RETRY_CONFIG.baseDelayMs * Math.pow(WEBHOOK_RETRY_CONFIG.backoffFactor, attemptCount),
    WEBHOOK_RETRY_CONFIG.maxDelayMs,
  )
  const jitter = Math.floor(Math.random() * WEBHOOK_RETRY_CONFIG.jitterMs)
  return exponential + jitter
}

/**
 * Generate HMAC-SHA256 signature for webhook payload.
 * Signature is computed over the JSON payload string.
 * @param payload JSON payload as string
 * @param signingSecret Webhook signing secret
 * @returns Hex-encoded HMAC signature
 */
export function generateWebhookSignature(payload: string, signingSecret: string): string {
  return crypto.createHmac('sha256', signingSecret).update(payload).digest('hex')
}

/**
 * Attempt to deliver a webhook by making HTTP POST to the target URL.
 * @returns Object with success flag, status code, and error message if applicable
 */
export async function attemptWebhookDelivery(params: {
  payload: string
  targetUrl: string
  signingSecret: string
  eventType: string
}): Promise<{
  success: boolean
  statusCode?: number
  error?: string
}> {
  const { payload, targetUrl, signingSecret, eventType } = params

  try {
    const signature = generateWebhookSignature(payload, signingSecret)

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 30000) // 30 second timeout

    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
        'X-Webhook-Event': eventType,
      },
      body: payload,
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

    // 2xx status codes are considered success
    const isSuccess = response.status >= 200 && response.status < 300

    return {
      success: isSuccess,
      statusCode: response.status,
      error: isSuccess ? undefined : `HTTP ${response.status}`,
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return {
      success: false,
      error: errorMessage,
    }
  }
}
