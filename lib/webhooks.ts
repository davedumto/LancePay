import crypto from 'crypto'
import { prisma } from './db'

/**
 * Supported webhook event types
 */
export type WebhookEventType = 
  | 'invoice.paid'
  | 'invoice.viewed'
  | 'invoice.created'
  | 'invoice.disputed'
  | 'withdrawal.completed'
  | 'withdrawal.failed'

/**
 * Webhook payload structure
 */
export interface WebhookPayload {
  event: WebhookEventType
  timestamp: string
  data: Record<string, unknown>
}

/**
 * Result of dispatching a webhook
 */
export interface WebhookDispatchResult {
  webhookId: string
  success: boolean
  statusCode?: number
  error?: string
  responseTime?: number
}

/**
 * Compute HMAC-SHA256 signature for webhook payload
 */
export function computeWebhookSignature(
  payload: string,
  secret: string
): string {
  return crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex')
}

/**
 * Dispatch webhooks for a specific event to all subscribed users
 * This function runs asynchronously and does not block the calling thread
 * Call without await to fire-and-forget
 */
export async function dispatchWebhooks(
  userId: string,
  eventType: WebhookEventType,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    // Find all active webhooks for this user subscribed to this event
    const webhooks = await prisma.userWebhook.findMany({
      where: {
        userId,
        isActive: true,
        subscribedEvents: {
          has: eventType,
        },
      },
    })

    if (webhooks.length === 0) {
      return // No webhooks to dispatch
    }

    // Construct the webhook payload
    const webhookPayload: WebhookPayload = {
      event: eventType,
      timestamp: new Date().toISOString(),
      data: payload,
    }

    const payloadString = JSON.stringify(webhookPayload)

    // Dispatch to each webhook (fire-and-forget, don't await)
    webhooks.forEach((webhook) => {
      dispatchToWebhook(webhook.id, webhook.targetUrl, webhook.signingSecret, payloadString, eventType)
        .catch((error) => {
          console.error(`Failed to dispatch webhook ${webhook.id}:`, error)
        })
    })
  } catch (error) {
    console.error('Error dispatching webhooks:', error)
    // Don't throw - webhook failures shouldn't break the main flow
  }
}

/**
 * Dispatch a webhook to a single URL
 */
async function dispatchToWebhook(
  webhookId: string,
  targetUrl: string,
  signingSecret: string,
  payload: string,
  eventType: WebhookEventType
): Promise<WebhookDispatchResult> {
  const startTime = Date.now()

  try {
    // Compute signature
    const signature = computeWebhookSignature(payload, signingSecret)

    // Send POST request with timeout
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 5000) // 5 second timeout

    try {
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-LancePay-Signature': signature,
          'X-LancePay-Event': eventType,
          'User-Agent': 'LancePay-Webhooks/1.0',
        },
        body: payload,
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      const responseTime = Date.now() - startTime
      const success = response.ok

      // Update last triggered timestamp
      await prisma.userWebhook.update({
        where: { id: webhookId },
        data: { lastTriggeredAt: new Date() },
      })

      if (!success) {
        console.warn(`Webhook ${webhookId} returned non-OK status: ${response.status}`)
      }

      return {
        webhookId,
        success,
        statusCode: response.status,
        responseTime,
      }
    } catch (fetchError) {
      clearTimeout(timeoutId)
      throw fetchError
    }
  } catch (error) {
    const responseTime = Date.now() - startTime
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'

    console.error(`Webhook dispatch failed for ${webhookId}:`, errorMessage)

    return {
      webhookId,
      success: false,
      error: errorMessage,
      responseTime,
    }
  }
}

/**
 * Generate a secure webhook signing secret
 */
export function generateWebhookSecret(): string {
  const randomBytes = crypto.randomBytes(32)
  return `whsec_${randomBytes.toString('base64url')}`
}

/**
 * Verify a webhook signature (for testing/debugging)
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const expectedSignature = computeWebhookSignature(payload, secret)
  
  // Ensure both signatures have the same length
  if (signature.length !== expectedSignature.length) {
    return false
  }
  
  return crypto.timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(expectedSignature, 'hex')
  )
}
