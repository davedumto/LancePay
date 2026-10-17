import { randomUUID } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { computeWebhookSignature } from '@/lib/webhook-signature'
import { requireWalletActor } from '@/app/api/_lib/collective-wallet-auth'

export const CANNED_WEBHOOK_EVENTS = [
  'invoice.created',
  'invoice.paid',
  'invoice.overdue',
  'payment.received',
  'payout.completed',
  'subscription.renewed',
] as const

export type CannedWebhookEvent = (typeof CANNED_WEBHOOK_EVENTS)[number]

const triggerWebhookSchema = z.object({
  webhookId: z.string().trim().min(1, 'webhookId is required'),
  eventType: z.enum(CANNED_WEBHOOK_EVENTS, {
    errorMap: () => ({
      message: `Unsupported canned eventType. Allowed values: ${CANNED_WEBHOOK_EVENTS.join(', ')}`,
    }),
  }),
  overrides: z.record(z.unknown()).optional(),
})

export function buildCannedEventData(
  eventType: CannedWebhookEvent,
  userId: string,
  nowIso: string,
  overrides?: Record<string, unknown>
): Record<string, unknown> {
  const templates: Record<CannedWebhookEvent, Record<string, unknown>> = {
    'invoice.created': {
      invoiceId: 'inv_sim_001',
      invoiceNumber: 'INV-SIM-0001',
      amount: '250.00',
      currency: 'USD',
      status: 'pending',
      clientEmail: 'client@sandbox.lancepay.test',
      createdAt: nowIso,
    },
    'invoice.paid': {
      invoiceId: 'inv_sim_001',
      invoiceNumber: 'INV-SIM-0001',
      amount: '250.00',
      currency: 'USD',
      status: 'paid',
      txHash: '0x9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b0a9f8e',
      paidAt: nowIso,
    },
    'invoice.overdue': {
      invoiceId: 'inv_sim_002',
      invoiceNumber: 'INV-SIM-0002',
      amount: '1200.00',
      currency: 'USD',
      status: 'overdue',
      dueDate: nowIso,
    },
    'payment.received': {
      paymentId: 'pay_sim_001',
      amount: '250.00',
      currency: 'USDC',
      network: 'stellar',
      receivedAt: nowIso,
    },
    'payout.completed': {
      payoutId: 'po_sim_001',
      amount: '500.00',
      currency: 'USD',
      status: 'completed',
      settledAt: nowIso,
    },
    'subscription.renewed': {
      subscriptionId: 'sub_sim_001',
      planName: 'Pro Freelancer Retainer',
      amount: '99.00',
      currency: 'USD',
      renewedAt: nowIso,
    },
  }

  return {
    userId,
    ...templates[eventType],
    ...(overrides ?? {}),
  }
}

/**
 * POST /api/webhook-simulator/trigger
 *
 * Fires a synthetic canned webhook event to an authenticated developer's UserWebhook:
 * - Rejects event shapes the target webhook does not subscribe to (422 EVENT_NOT_SUBSCRIBED).
 * - Signs the exact JSON payload string with the webhook's real `signingSecret` via
 *   `computeWebhookSignature` (`sha256=<hex>`) so the receiver's verification code path
 *   is identical to a live delivery.
 * - Persists a `WebhookDelivery` row flagged as synthetic (`isSynthetic: true` in payload
 *   and `simulated_delivered` / `simulated_failed` status) without touching live failure
 *   counters (`consecutiveFailures`) or `webhook-deliveries/stats` failure denominators.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await requireWalletActor(request)
    if ('response' in auth) return auth.response
    const { actor } = auth

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = triggerWebhookSchema.safeParse(rawBody)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      )
    }

    const { webhookId, eventType, overrides } = parsed.data

    const webhook = await prisma.userWebhook.findUnique({
      where: { id: webhookId },
      select: {
        id: true,
        userId: true,
        targetUrl: true,
        signingSecret: true,
        isActive: true,
        status: true,
        subscribedEvents: true,
      },
    })

    if (!webhook) {
      return NextResponse.json(
        { error: 'Webhook not found', code: 'WEBHOOK_NOT_FOUND' },
        { status: 404 }
      )
    }

    if (webhook.userId !== actor.id) {
      return NextResponse.json(
        { error: 'Forbidden: you do not own this webhook', code: 'FORBIDDEN' },
        { status: 403 }
      )
    }

    const subscribed = Array.isArray(webhook.subscribedEvents) ? webhook.subscribedEvents : []
    const isSubscribed = subscribed.includes(eventType) || subscribed.includes('*')

    if (!isSubscribed) {
      return NextResponse.json(
        {
          error: `Webhook is not subscribed to "${eventType}"`,
          code: 'EVENT_NOT_SUBSCRIBED',
          details: {
            requestedEvent: eventType,
            subscribedEvents: subscribed,
          },
        },
        { status: 422 }
      )
    }

    const now = new Date()
    const nowIso = now.toISOString()
    const eventId = `evt_sim_${randomUUID()}`

    const envelope = {
      id: eventId,
      type: eventType,
      createdAt: nowIso,
      isSynthetic: true,
      livemode: false,
      data: buildCannedEventData(eventType, actor.id, nowIso, overrides),
    }

    const serializedPayload = JSON.stringify(envelope)
    const signature = computeWebhookSignature(serializedPayload, webhook.signingSecret)

    let httpStatus: number | null = null
    let lastError: string | null = null
    let delivered = false

    try {
      const response = await fetch(webhook.targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-LancePay-Signature': signature,
          'X-LancePay-Event': eventType,
          'X-LancePay-Event-Id': eventId,
          'X-LancePay-Synthetic': 'true',
        },
        body: serializedPayload,
      })

      httpStatus = response.status
      delivered = response.ok
      if (!response.ok) {
        lastError = `Endpoint responded with HTTP ${response.status}`
      }
    } catch (err: any) {
      lastError = err?.message || 'Network error while dispatching synthetic webhook'
    }

    // Use simulated_* status so live stats (/api/webhook-deliveries/stats) exclude it from
    // terminal live failure denominators, and never increment consecutiveFailures on UserWebhook.
    const deliveryStatus = delivered ? 'simulated_delivered' : 'simulated_failed'

    const delivery = await prisma.webhookDelivery.create({
      data: {
        webhookId: webhook.id,
        eventType,
        payload: serializedPayload,
        status: deliveryStatus,
        attemptCount: 1,
        lastAttemptAt: now,
        lastStatusCode: httpStatus,
        lastError,
      },
      select: {
        id: true,
        webhookId: true,
        eventType: true,
        status: true,
        attemptCount: true,
        lastStatusCode: true,
        lastError: true,
        lastAttemptAt: true,
        createdAt: true,
      },
    })

    logger.info(
      {
        webhookId: webhook.id,
        deliveryId: delivery.id,
        eventType,
        delivered,
        httpStatus,
        isSynthetic: true,
      },
      'Synthetic webhook triggered'
    )

    return NextResponse.json(
      {
        delivery: {
          ...delivery,
          isSynthetic: true,
        },
        signature,
        payload: envelope,
      },
      { status: 200 }
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/webhook-simulator/trigger error')
    return NextResponse.json(
      { error: 'Failed to trigger synthetic webhook' },
      { status: 500 }
    )
  }
}
