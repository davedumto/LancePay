import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { sendWebhookDisabledEmail } from '@/lib/email'

/**
 * Webhook delivery replay configuration.
 * Exponential backoff with jitter to prevent thundering herd.
 */
const WEBHOOK_RETRY_CONFIG = {
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
function computeNextRetryDelayMs(attemptCount: number): number {
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
function generateWebhookSignature(payload: string, signingSecret: string): string {
  return crypto.createHmac('sha256', signingSecret).update(payload).digest('hex')
}

/**
 * Attempt to deliver a webhook by making HTTP POST to the target URL.
 * Updates delivery record with attempt outcome (status code, error, timestamp).
 * @returns Object with success flag, status code, and error message if applicable
 */
async function attemptWebhookDelivery(params: {
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

/**
 * POST /api/webhook-deliveries/[id]/replay
 *
 * Manually replay a failed or pending webhook delivery.
 * Performs synchronous HTTP delivery attempt, updates delivery record with outcome,
 * and manages parent webhook's consecutive failure count and status.
 *
 * Authorization: Authenticated user who owns the webhook
 * Status: 200 OK on successful attempt (delivery may succeed or fail)
 *         401 Unauthorized if not authenticated
 *         404 Not Found if delivery doesn't exist or user doesn't own it
 *         409 Conflict if delivery is already succeeded
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const authHeader = request.headers.get('authorization')
    if (!authHeader) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Verify authentication
    let claims
    try {
      claims = await verifyAuthToken(authHeader)
    } catch {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    if (!claims?.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Look up user by Privy ID
    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 401 })
    }

    const deliveryId = (await params).id

    // Look up delivery with related webhook
    const delivery = await prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
      include: { webhook: true },
    })

    // Return 404 if delivery doesn't exist
    if (!delivery) {
      return NextResponse.json(
        { error: 'Delivery not found' },
        { status: 404 },
      )
    }

    // Verify ownership: user must own the parent webhook
    if (delivery.webhook.userId !== user.id) {
      return NextResponse.json(
        { error: 'Delivery not found' },
        { status: 404 },
      )
    }

    // Reject if delivery is already succeeded
    if (delivery.status === 'delivered') {
      return NextResponse.json(
        { error: 'Cannot replay a delivery that has already succeeded' },
        { status: 409 },
      )
    }

    // Only allow replay for pending, failed, or dead_lettered deliveries
    if (!['pending', 'failed', 'dead_lettered'].includes(delivery.status)) {
      return NextResponse.json(
        { error: 'Delivery cannot be replayed in its current state' },
        { status: 409 },
      )
    }

    // Attempt delivery
    const attemptResult = await attemptWebhookDelivery({
      payload: delivery.payload,
      targetUrl: delivery.webhook.targetUrl,
      signingSecret: delivery.webhook.signingSecret,
      eventType: delivery.eventType,
    })

    // Determine new delivery status and webhook status update
    const newDeliveryStatus = attemptResult.success ? 'delivered' : 'failed'
    const newAttemptCount = delivery.attemptCount + 1

    // Compute next retry delay (for failed deliveries)
    let nextRetryAt: Date | null = null
    let shouldDeadLetter = false

    if (!attemptResult.success) {
      // Check if we've exceeded max attempts
      if (newAttemptCount >= WEBHOOK_RETRY_CONFIG.maxAttempts) {
        shouldDeadLetter = true
        // Dead-lettered deliveries don't get a next retry
        nextRetryAt = null
      } else {
        // Schedule next retry
        const delayMs = computeNextRetryDelayMs(newAttemptCount - 1)
        nextRetryAt = new Date(Date.now() + delayMs)
      }
    } else {
      // Successful delivery: no future retries
      nextRetryAt = null
    }

    // Update consecutive failures on parent webhook
    let newConsecutiveFailures = delivery.webhook.consecutiveFailures
    if (attemptResult.success) {
      newConsecutiveFailures = 0 // Reset on success
    } else {
      newConsecutiveFailures += 1 // Increment on failure
    }

    // Determine if webhook should be auto-disabled
    const shouldDisableWebhook =
      !attemptResult.success &&
      newConsecutiveFailures >= WEBHOOK_RETRY_CONFIG.consecutiveFailuresThreshold

    // Wrap delivery and webhook updates in a transaction for atomicity
    const result = await prisma.$transaction(async (tx) => {
      // Update delivery record
      const updatedDelivery = await tx.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: shouldDeadLetter ? 'dead_lettered' : newDeliveryStatus,
          attemptCount: newAttemptCount,
          lastAttemptAt: new Date(),
          lastStatusCode: attemptResult.statusCode,
          lastError: attemptResult.error,
          nextRetryAt,
          updatedAt: new Date(),
        },
      })

      // Update parent webhook's consecutive failures and status
      const webhookUpdateData: any = {
        consecutiveFailures: newConsecutiveFailures,
        lastFailureAt: attemptResult.success ? delivery.webhook.lastFailureAt : new Date(),
      }

      if (shouldDisableWebhook) {
        webhookUpdateData.status = 'INACTIVE'
        webhookUpdateData.isActive = false
      }

      const updatedWebhook = await tx.userWebhook.update({
        where: { id: delivery.webhookId },
        data: webhookUpdateData,
      })

      return {
        delivery: updatedDelivery,
        webhook: updatedWebhook,
      }
    })

    // Send email notification if webhook was auto-disabled
    if (shouldDisableWebhook) {
      try {
        await sendWebhookDisabledEmail({
          to: user.email,
          userName: user.name || 'User',
          webhookUrl: delivery.webhook.targetUrl,
          lastError: attemptResult.error || 'Multiple consecutive failures',
          autoDisabled: true,
        })
      } catch (emailError) {
        // Log but don't fail the request if email sending fails
        console.error('Failed to send webhook disabled email:', emailError)
      }
    }

    return NextResponse.json(
      {
        message: 'Webhook delivery replayed successfully',
        delivery: {
          id: result.delivery.id,
          status: result.delivery.status,
          attemptCount: result.delivery.attemptCount,
          lastStatusCode: result.delivery.lastStatusCode,
          lastError: result.delivery.lastError,
          nextRetryAt: result.delivery.nextRetryAt,
        },
        webhook: {
          id: result.webhook.id,
          consecutiveFailures: result.webhook.consecutiveFailures,
          status: result.webhook.status,
          isActive: result.webhook.isActive,
        },
        deliveryAttempt: {
          success: attemptResult.success,
          statusCode: attemptResult.statusCode,
          error: attemptResult.error,
        },
      },
      { status: 200 },
    )
  } catch (error) {
    console.error('Webhook delivery replay error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}
