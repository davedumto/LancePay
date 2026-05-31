import { prisma } from '@/lib/db'
import { signWebhookPayload } from './hmac'
import { logger } from '../_shared/logger'

export const WEBHOOK_TIMESTAMP_HEADER = 'x-lancepay-timestamp'
export const WEBHOOK_SIGNATURE_HEADER = 'x-lancepay-signature'

type WebhookForDelivery = {
  id: string
  targetUrl: string
  signingSecret: string
}

export type WebhookDeliveryResult = {
  ok: boolean
  status: number
  latencyMs: number
  errorMessage?: string
}

export async function dispatchWebhookDelivery(
  webhook: WebhookForDelivery,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<WebhookDeliveryResult> {
  const body = JSON.stringify(payload)
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = signWebhookPayload(webhook.signingSecret, timestamp, body)
  const startedAt = Date.now()

  try {
    const response = await fetch(webhook.targetUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
        [WEBHOOK_SIGNATURE_HEADER]: signature,
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

    logger.error(
      { err: error, webhookId: webhook.id, eventType },
      'routes-d webhook delivery failed',
    )

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

    return {
      ok: false,
      status: 0,
      latencyMs,
      errorMessage: message,
    }
  }
}
