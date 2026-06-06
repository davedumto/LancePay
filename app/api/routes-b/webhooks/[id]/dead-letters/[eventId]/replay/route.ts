import { withRequestId } from '../../../../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { deadLetterQueue } from '../../../../../_lib/dead-letter'
import { dispatchWebhookDelivery } from '../../../../../_lib/webhook-delivery'
import { registerRoute } from '../../../../../_lib/openapi'
import { z } from 'zod'

// Register OpenAPI documentation
registerRoute({
  method: 'POST',
  path: '/webhooks/{id}/dead-letters/{eventId}/replay',
  summary: 'Replay dead-letter event',
  description: 'Retry a specific dead-letter event.',
  responseSchema: z.object({
    success: z.boolean(),
    delivery: z.object({
      ok: z.boolean(),
      status: z.number(),
      latencyMs: z.number(),
      errorMessage: z.string().optional(),
    }).optional(),
  }),
  tags: ['webhooks']
})

async function POSTHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; eventId: string }> },
) {
  const { id, eventId } = await params

  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const webhook = await prisma.userWebhook.findUnique({
    where: { id },
    select: { id: true, userId: true, targetUrl: true, signingSecret: true },
  })

  if (!webhook) {
    return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })
  }

  if (webhook.userId !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Get and remove the dead-letter event
  const deadLetterEvent = deadLetterQueue.replay(id, eventId)
  if (!deadLetterEvent) {
    return NextResponse.json({ error: 'Dead-letter event not found' }, { status: 404 })
  }

  try {
    // Parse the payload and replay the webhook
    const payload = JSON.parse(deadLetterEvent.payload)
    const delivery = await dispatchWebhookDelivery(
      {
        id: webhook.id,
        targetUrl: webhook.targetUrl,
        signingSecret: webhook.signingSecret,
      },
      deadLetterEvent.eventType,
      payload
    )

    return NextResponse.json({
      success: true,
      delivery,
    })
  } catch (error) {
    // If replay fails, push it back to the dead-letter queue
    deadLetterQueue.push(id, {
      webhookId: id,
      eventType: deadLetterEvent.eventType,
      payload: deadLetterEvent.payload,
      lastError: error instanceof Error ? error.message : 'Replay failed',
      attemptCount: deadLetterEvent.attemptCount + 1,
      lastStatusCode: deadLetterEvent.lastStatusCode,
    })

    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Replay failed',
    }, { status: 500 })
  }
}

export const POST = withRequestId(POSTHandler)
