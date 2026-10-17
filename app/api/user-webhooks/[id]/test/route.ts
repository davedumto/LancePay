import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { computeWebhookSignature } from '@/lib/webhook-signature'

const TEST_PING_EVENT_TYPE = 'test.ping'
const TEST_DELIVERY_TIMEOUT_MS = 10_000

/**
 * POST /api/user-webhooks/[id]/test
 *
 * Sends a synthetic `test.ping` event signed with the webhook's current
 * `signingSecret` to `targetUrl` so the owner can verify endpoint reachability
 * and HMAC-SHA256 signature verification.
 *
 * Records a `WebhookDelivery` row (`eventType: 'test.ping'`) with the outcome
 * (`status`, `lastStatusCode`, `lastError`, `attemptCount: 1`) without
 * incrementing `consecutiveFailures` or disabling the webhook on failure, so
 * synthetic reachability probes never pollute real delivery failure metrics.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims?.userId) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const { id } = await params

    const webhook = await prisma.userWebhook.findUnique({ where: { id } })
    if (!webhook) {
      return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })
    }

    if (webhook.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const now = new Date()
    const payloadObj = {
      event: TEST_PING_EVENT_TYPE,
      webhookId: webhook.id,
      timestamp: now.toISOString(),
      data: {
        message: 'LancePay webhook reachability test',
      },
    }
    const payload = JSON.stringify(payloadObj)
    const signature = computeWebhookSignature(payload, webhook.signingSecret)

    const startTime = Date.now()
    let statusCode: number | null = null
    let delivered = false
    let deliveryError: string | null = null

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), TEST_DELIVERY_TIMEOUT_MS)

    try {
      const response = await fetch(webhook.targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-LancePay-Signature': signature,
          'X-Webhook-Signature': signature,
          'X-Webhook-Event': TEST_PING_EVENT_TYPE,
          'User-Agent': 'LancePay-Webhook-Test/1.0',
        },
        body: payload,
        signal: controller.signal,
      })

      statusCode = response.status
      delivered = response.status >= 200 && response.status < 300
      if (!delivered) {
        deliveryError = `HTTP ${response.status}`
      }
    } catch (fetchErr) {
      delivered = false
      if (fetchErr instanceof Error && fetchErr.name === 'AbortError') {
        deliveryError = `Request timed out after ${TEST_DELIVERY_TIMEOUT_MS}ms`
      } else {
        deliveryError = fetchErr instanceof Error ? fetchErr.message : 'Network error'
      }
    } finally {
      clearTimeout(timeoutId)
    }

    const latencyMs = Math.max(0, Date.now() - startTime)

    const delivery = await prisma.webhookDelivery.create({
      data: {
        webhookId: webhook.id,
        eventType: TEST_PING_EVENT_TYPE,
        payload,
        status: delivered ? 'delivered' : 'failed',
        attemptCount: 1,
        lastAttemptAt: now,
        nextRetryAt: null,
        lastStatusCode: statusCode,
        lastError: deliveryError,
      },
    })

    logger.info(
      {
        userId: user.id,
        webhookId: webhook.id,
        deliveryId: delivery.id,
        delivered,
        statusCode,
        latencyMs,
      },
      'Webhook test ping executed',
    )

    return NextResponse.json(
      {
        deliveryId: delivery.id,
        webhookId: webhook.id,
        eventType: TEST_PING_EVENT_TYPE,
        delivered,
        statusCode,
        latencyMs,
        signature,
        error: deliveryError,
      },
      { status: 200 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/user-webhooks/[id]/test error')
    return NextResponse.json(
      { error: 'Failed to send test webhook event' },
      { status: 500 },
    )
  }
}
