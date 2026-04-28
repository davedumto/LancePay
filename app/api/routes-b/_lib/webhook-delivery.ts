import { prisma } from '@/lib/db'
import { signWebhookPayload } from './hmac'
import { shouldDeadLetter, pushToDeadLetter } from './dead-letter'

type WebhookForDelivery = {
  id: string
  targetUrl: string
  signingSecret: string
}

type DeliveryResult = {
  ok: boolean
  status: number
  latencyMs: number
  errorMessage?: string
}

export async function dispatchWebhookDelivery(
  webhook: WebhookForDelivery,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<DeliveryResult> {
  const body = JSON.stringify(payload)
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = signWebhookPayload(webhook.signingSecret, timestamp, body)
  const startedAt = Date.now()

  try {
    const response = await fetch(webhook.targetUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-lancepay-timestamp': timestamp,
        'x-lancepay-signature': signature,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    })

    const latencyMs = Date.now() - startedAt
    const deliveryStatus = response.ok ? 'success' : 'failed'
    
    await prisma.webhookDelivery.create({
      data: {
        webhookId: webhook.id,
        eventType,
        payload: body,
        status: deliveryStatus,
        attemptCount: 1,
        lastAttemptAt: new Date(),
        lastStatusCode: response.status,
      },
    })

    // Push to dead-letter queue if failed and this would be the final attempt
    if (!response.ok && shouldDeadLetter(deliveryStatus, 1)) {
      pushToDeadLetter(webhook.id, {
        eventType,
        payload: body,
        lastError: `Upstream responded with ${response.status}`,
        attemptCount: 1,
        lastStatusCode: response.status,
      })
    }
    await prisma.userWebhook.update({
      where: { id: webhook.id },
      data: { lastTriggeredAt: new Date() },
    })

    return {
      ok: response.ok,
      status: response.status,
      latencyMs,
      ...(response.ok ? {} : { errorMessage: `Upstream responded with ${response.status}` }),
    }
  } catch (error) {
    const latencyMs = Date.now() - startedAt
    const message = error instanceof Error ? error.message : 'Failed to dispatch webhook'
    
    await prisma.webhookDelivery.create({
      data: {
        webhookId: webhook.id,
        eventType,
        payload: body,
        status: 'failed',
        attemptCount: 1,
        lastAttemptAt: new Date(),
        lastError: message,
      },
    })

    // Push to dead-letter queue if this would be the final attempt
    if (shouldDeadLetter('failed', 1)) {
      pushToDeadLetter(webhook.id, {
        eventType,
        payload: body,
        lastError: message,
        attemptCount: 1,
      })
    }

    return {
      ok: false,
      status: 0,
      latencyMs,
      errorMessage: message,
    }
  }
}

