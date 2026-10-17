import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const triggerSimulatorSchema = z.object({
  webhookId: z.string().min(1, 'webhookId is required'),
  eventType: z.string().min(1, 'eventType is required'),
  customPayload: z.record(z.string(), z.unknown()).optional(),
})

/**
 * Returns a default canned event payload shape for a simulated event.
 */
function getCannedEventData(eventType: string) {
  switch (eventType) {
    case 'invoice.paid':
      return {
        invoiceId: `inv_sim_${Date.now()}`,
        amountUsdc: '150.000000',
        payerAddress: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
        paidAt: new Date().toISOString(),
        currency: 'USDC',
      }
    case 'invoice.created':
      return {
        invoiceId: `inv_sim_${Date.now()}`,
        amountUsdc: '250.000000',
        recipient: 'client@example.com',
        dueDate: new Date(Date.now() + 7 * 86400000).toISOString(),
      }
    case 'payout.completed':
      return {
        payoutId: `payout_sim_${Date.now()}`,
        amountUsdc: '1000.000000',
        destinationAddress: 'GCZJOGJOH3W66Q3C33V4D7GDF4D7M5Y7R25D3U4Z7Y3ZMFSHONUCEOA',
        completedAt: new Date().toISOString(),
      }
    default:
      return {
        event: eventType,
        simulated: true,
        timestamp: new Date().toISOString(),
      }
  }
}

/**
 * POST /api/webhook-simulator/trigger
 *
 * Fires a synthetic webhook payload to a developer's configured webhook endpoint
 * for testing and integration validation.
 *
 * Guarantees:
 * 1. Payload is signed with the webhook's real HMAC-SHA256 signing secret so the
 *    developer handler's signature verification executes the exact production logic.
 * 2. Rejects triggering event shapes that the developer's webhook is not subscribed to (400).
 * 3. Records the simulated delivery in the standard `WebhookDelivery` table, flagged
 *    as synthetic (`status: 'synthetic_delivered'` / `'synthetic_failed'`, `isSynthetic: true` in payload)
 *    so it never contaminates production delivery stats.
 */
export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = triggerSimulatorSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      )
    }

    const { webhookId, eventType, customPayload } = parsed.data

    const webhook = await prisma.userWebhook.findFirst({
      where: {
        id: webhookId,
        userId: user.id,
      },
      select: {
        id: true,
        targetUrl: true,
        signingSecret: true,
        subscribedEvents: true,
        isActive: true,
      },
    })

    if (!webhook) {
      return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })
    }

    // Reject triggering an event shape the caller's developer app does not subscribe to
    if (!webhook.subscribedEvents.includes(eventType)) {
      return NextResponse.json(
        {
          error: `Webhook is not subscribed to event '${eventType}'. Subscribed events: [${webhook.subscribedEvents.join(', ')}]`,
          code: 'UNSUBSCRIBED_EVENT',
        },
        { status: 400 },
      )
    }

    // Build the synthetic event payload
    const syntheticPayloadObj = {
      id: `evt_sim_${crypto.randomUUID()}`,
      type: eventType,
      isSynthetic: true,
      simulatedAt: new Date().toISOString(),
      data: customPayload ?? getCannedEventData(eventType),
    }
    const payloadString = JSON.stringify(syntheticPayloadObj)

    // Sign the synthetic payload with the real signing secret
    const signature = crypto
      .createHmac('sha256', webhook.signingSecret)
      .update(payloadString)
      .digest('hex')

    // Dispatch HTTP POST to the target URL
    let isSuccess = false
    let statusCode: number | null = null
    let lastError: string | null = null

    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 15000)

      const response = await fetch(webhook.targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signature,
          'X-Webhook-Event': eventType,
          'X-Webhook-Synthetic': 'true',
        },
        body: payloadString,
        signal: controller.signal,
      })

      clearTimeout(timeoutId)
      statusCode = response.status
      isSuccess = response.status >= 200 && response.status < 300
      if (!isSuccess) {
        lastError = `Target endpoint responded with HTTP ${response.status}`
      }
    } catch (fetchErr) {
      isSuccess = false
      lastError = fetchErr instanceof Error ? fetchErr.message : String(fetchErr)
    }

    // Record the simulated delivery in WebhookDelivery table.
    // Flagged as 'synthetic_delivered' / 'synthetic_failed' so delivery stats (which query
    // terminal statuses 'delivered' / 'success' / 'failed' / 'dead') never count this synthetic delivery.
    const delivery = await prisma.webhookDelivery.create({
      data: {
        webhookId: webhook.id,
        eventType: `[SYNTHETIC] ${eventType}`,
        payload: payloadString,
        status: isSuccess ? 'synthetic_delivered' : 'synthetic_failed',
        attemptCount: 1,
        lastAttemptAt: new Date(),
        lastStatusCode: statusCode,
        lastError,
      },
      select: {
        id: true,
        status: true,
        attemptCount: true,
        lastAttemptAt: true,
        lastStatusCode: true,
        createdAt: true,
      },
    })

    logger.info(
      {
        webhookId: webhook.id,
        deliveryId: delivery.id,
        eventType,
        isSuccess,
        statusCode,
      },
      'Synthetic webhook delivery executed via simulator',
    )

    return NextResponse.json(
      {
        success: isSuccess,
        deliveryId: delivery.id,
        eventType,
        targetUrl: webhook.targetUrl,
        statusCode,
        isSynthetic: true,
        error: lastError,
        delivery,
      },
      { status: isSuccess ? 200 : 502 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/webhook-simulator/trigger error')
    return NextResponse.json(
      { error: 'Failed to process simulated webhook trigger' },
      { status: 500 },
    )
  }
}
