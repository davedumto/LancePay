import crypto from 'crypto'
import { Client } from '@upstash/qstash'
import { prisma } from './db'
import { sendWebhookDisabledEmail } from './email'

/**
 * Supported webhook event types
 */
export type WebhookEventType =
  | 'invoice.paid'
  | 'invoice.viewed'
  | 'invoice.created'
  | 'invoice.disputed'
  | 'invoice.message'
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
 * Retry backoff schedule in milliseconds after each failed attempt.
 * Attempts: immediate, +1m, +5m, +15m, +1h, +6h, +24h (max 7 attempts)
 */
const RETRY_DELAYS_MS = [
  1 * 60_000,      // 1 minute
  5 * 60_000,      // 5 minutes
  15 * 60_000,     // 15 minutes
  60 * 60_000,     // 1 hour
  6 * 60 * 60_000, // 6 hours
  24 * 60 * 60_000, // 24 hours
] as const

const MAX_ATTEMPTS = 7
const AUTO_DISABLE_FAILURE_THRESHOLD = 10

const qstashClient = new Client({ token: process.env.QSTASH_TOKEN || '' })

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
 * Pure HTTP delivery function — makes the POST request and returns the result.
 * No database calls. Reused by initial dispatch, retry, and manual retry paths.
 */
export async function sendWebhookRequest(
  targetUrl: string,
  signingSecret: string,
  payload: string,
  eventType: string
): Promise<WebhookDispatchResult> {
  const startTime = Date.now()

  try {
    const signature = computeWebhookSignature(payload, signingSecret)
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 5000)

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

      return {
        webhookId: '',
        success: response.ok,
        statusCode: response.status,
        responseTime: Date.now() - startTime,
      }
    } catch (fetchError) {
      clearTimeout(timeoutId)
      throw fetchError
    }
  } catch (error) {
    return {
      webhookId: '',
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      responseTime: Date.now() - startTime,
    }
  }
}

/**
 * Dispatch webhooks for a specific event to all subscribed users.
 * Runs asynchronously and does not block the calling thread.
 * Call without await to fire-and-forget.
 */
export async function dispatchWebhooks(
  userId: string,
  eventType: WebhookEventType,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    const webhooks = await prisma.userWebhook.findMany({
      where: {
        userId,
        isActive: true,
        status: { not: 'DISABLED' },
        subscribedEvents: {
          has: eventType,
        },
      },
    })

    if (webhooks.length === 0) {
      return
    }

    const webhookPayload: WebhookPayload = {
      event: eventType,
      timestamp: new Date().toISOString(),
      data: payload,
    }

    const payloadString = JSON.stringify(webhookPayload)

    // Fire-and-forget first attempt for each webhook
    webhooks.forEach((webhook) => {
      attemptDelivery(webhook, payloadString, eventType)
        .catch((error) => {
          console.error(`Failed to dispatch webhook ${webhook.id}:`, error)
        })
    })
  } catch (error) {
    console.error('Error dispatching webhooks:', error)
  }
}

/**
 * First delivery attempt. On success, updates webhook stats.
 * On failure, creates a WebhookDelivery record and schedules a retry via QStash.
 */
async function attemptDelivery(
  webhook: { id: string; targetUrl: string; signingSecret: string },
  payload: string,
  eventType: WebhookEventType
): Promise<void> {
  const result = await sendWebhookRequest(
    webhook.targetUrl,
    webhook.signingSecret,
    payload,
    eventType
  )

  if (result.success) {
    await prisma.userWebhook.update({
      where: { id: webhook.id },
      data: {
        lastTriggeredAt: new Date(),
        consecutiveFailures: 0,
        status: 'ACTIVE',
      },
    })
    return
  }

  // First attempt failed — create delivery record and schedule retry
  const now = new Date()
  const nextRetryAt = new Date(now.getTime() + RETRY_DELAYS_MS[0])

  const delivery = await prisma.$transaction(async (tx) => {
    const created = await tx.webhookDelivery.create({
      data: {
        webhookId: webhook.id,
        eventType,
        payload,
        status: 'pending',
        attemptCount: 1,
        lastAttemptAt: now,
        nextRetryAt,
        lastStatusCode: result.statusCode ?? null,
        lastError: result.error ?? null,
      },
    })

    await tx.userWebhook.update({
      where: { id: webhook.id },
      data: {
        lastFailureAt: now,
        consecutiveFailures: { increment: 1 },
        status: 'FAILING',
      },
    })

    return created
  })

  // Schedule retry via QStash
  scheduleRetry(delivery.id, RETRY_DELAYS_MS[0]).catch((err) =>
    console.error(`Failed to schedule QStash retry for delivery ${delivery.id}:`, err)
  )
}

/**
 * Schedule a retry via QStash with a given delay.
 */
async function scheduleRetry(deliveryId: string, delayMs: number): Promise<void> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) {
    console.error('NEXT_PUBLIC_APP_URL not set — cannot schedule QStash retry')
    return
  }

  await qstashClient.publishJSON({
    url: `${appUrl}/api/webhooks/retry`,
    body: { deliveryId },
    delay: Math.ceil(delayMs / 1000),
  })
}

/**
 * Process a single retry delivery. Called by the QStash callback and the daily cron sweep.
 * Returns true if delivered successfully, false otherwise.
 */
export async function processRetryDelivery(deliveryId: string): Promise<boolean> {
  const delivery = await prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
    include: {
      webhook: {
        select: { id: true, targetUrl: true, signingSecret: true, userId: true },
      },
    },
  })

  if (!delivery || delivery.status !== 'pending') {
    return false
  }

  const result = await sendWebhookRequest(
    delivery.webhook.targetUrl,
    delivery.webhook.signingSecret,
    delivery.payload,
    delivery.eventType
  )

  const newAttemptCount = delivery.attemptCount + 1
  const now = new Date()

  if (result.success) {
    await prisma.$transaction([
      prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'delivered',
          attemptCount: newAttemptCount,
          lastAttemptAt: now,
          nextRetryAt: null,
          lastStatusCode: result.statusCode ?? null,
          lastError: null,
        },
      }),
      prisma.userWebhook.update({
        where: { id: delivery.webhookId },
        data: {
          lastTriggeredAt: now,
          consecutiveFailures: 0,
          status: 'ACTIVE',
        },
      }),
    ])
    return true
  }

  // Retry failed
  const isExhausted = newAttemptCount >= MAX_ATTEMPTS
  const webhookFailureState = await prisma.userWebhook.update({
    where: { id: delivery.webhookId },
    data: {
      lastFailureAt: now,
      consecutiveFailures: { increment: 1 },
      status: 'FAILING',
    },
    select: {
      consecutiveFailures: true,
      userId: true,
      targetUrl: true,
    },
  })

  const shouldDisableWebhook = webhookFailureState.consecutiveFailures >= AUTO_DISABLE_FAILURE_THRESHOLD

  if (isExhausted) {
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'failed',
        attemptCount: newAttemptCount,
        lastAttemptAt: now,
        nextRetryAt: null,
        lastStatusCode: result.statusCode ?? null,
        lastError: result.error ?? null,
      },
    })

    if (shouldDisableWebhook) {
      await prisma.userWebhook.update({
        where: { id: delivery.webhookId },
        data: {
          status: 'DISABLED',
          isActive: false,
        },
      })
    }

    // Notify on permanent delivery failure.
    const user = await prisma.user.findUnique({
      where: { id: webhookFailureState.userId },
      select: { email: true, name: true },
    })

    if (user?.email) {
      sendWebhookDisabledEmail({
        to: user.email,
        userName: user.name || 'there',
        webhookUrl: webhookFailureState.targetUrl,
        lastError: result.error || `HTTP ${result.statusCode}`,
        autoDisabled: shouldDisableWebhook,
      }).catch((err) => console.error('Failed to send webhook disabled email:', err))
    }

    return false
  }

  // More retries remain — schedule next retry
  const nextDelay = RETRY_DELAYS_MS[newAttemptCount - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]
  const nextRetryAt = new Date(now.getTime() + nextDelay)

  await prisma.webhookDelivery.update({
    where: { id: deliveryId },
    data: {
      attemptCount: newAttemptCount,
      lastAttemptAt: now,
      nextRetryAt,
      lastStatusCode: result.statusCode ?? null,
      lastError: result.error ?? null,
    },
  })

  if (shouldDisableWebhook) {
    await prisma.userWebhook.update({
      where: { id: delivery.webhookId },
      data: {
        status: 'DISABLED',
        isActive: false,
      },
    })
  }

  // Schedule next retry via QStash
  scheduleRetry(deliveryId, nextDelay).catch((err) =>
    console.error(`Failed to schedule QStash retry for delivery ${deliveryId}:`, err)
  )

  return false
}

/**
 * Manually retry a delivery. Bypasses QStash — attempts immediately.
 * Works on both 'pending' and 'failed' deliveries.
 * On success, reactivates the webhook.
 */
export async function manualRetry(deliveryId: string): Promise<WebhookDispatchResult> {
  const delivery = await prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
    include: {
      webhook: {
        select: { id: true, targetUrl: true, signingSecret: true },
      },
    },
  })

  if (!delivery) {
    return { webhookId: '', success: false, error: 'Delivery not found' }
  }

  if (delivery.status === 'delivered') {
    return { webhookId: delivery.webhookId, success: false, error: 'Already delivered' }
  }

  const result = await sendWebhookRequest(
    delivery.webhook.targetUrl,
    delivery.webhook.signingSecret,
    delivery.payload,
    delivery.eventType
  )

  const now = new Date()

  if (result.success) {
    await prisma.$transaction([
      prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'delivered',
          lastAttemptAt: now,
          nextRetryAt: null,
          lastStatusCode: result.statusCode ?? null,
          lastError: null,
        },
      }),
      prisma.userWebhook.update({
        where: { id: delivery.webhookId },
        data: {
          lastTriggeredAt: now,
          consecutiveFailures: 0,
          status: 'ACTIVE',
          isActive: true,
        },
      }),
    ])
  } else {
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        lastAttemptAt: now,
        lastStatusCode: result.statusCode ?? null,
        lastError: result.error ?? null,
      },
    })
  }

  return {
    webhookId: delivery.webhookId,
    success: result.success,
    statusCode: result.statusCode,
    error: result.error,
    responseTime: result.responseTime,
  }
}

/**
 * Process all pending retries. Called by the daily cron sweep.
 * Processes in parallel with Promise.allSettled for efficiency.
 */
export async function processPendingRetries(limit = 50): Promise<{
  processed: number
  delivered: number
  failed: number
}> {
  const pendingDeliveries = await prisma.webhookDelivery.findMany({
    where: {
      status: 'pending',
      nextRetryAt: { lte: new Date() },
    },
    orderBy: { nextRetryAt: 'asc' },
    take: limit,
    select: { id: true },
  })

  let delivered = 0
  let failed = 0

  const results = await Promise.allSettled(
    pendingDeliveries.map((d) => processRetryDelivery(d.id))
  )

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      delivered++
    } else {
      failed++
    }
  }

  return {
    processed: pendingDeliveries.length,
    delivered,
    failed,
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
