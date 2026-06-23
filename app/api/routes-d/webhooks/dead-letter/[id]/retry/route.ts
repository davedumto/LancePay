import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

// How long before a dead-lettered delivery can be retried again after the
// last attempt. Prevents rapid manual retries from hammering the target URL.
const MIN_RETRY_INTERVAL_MS = 30_000

type WebhookDeliveryDelegate = {
  findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>
  update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

function getDeliveryDelegate(): WebhookDeliveryDelegate {
  return (prisma as unknown as { webhookDelivery: WebhookDeliveryDelegate }).webhookDelivery
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const user = await getAuthenticatedUser(request)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const deliveryId = params.id?.trim()
  if (!deliveryId) {
    return NextResponse.json({ error: 'Delivery ID is required.' }, { status: 400 })
  }

  const delegate = getDeliveryDelegate()

  // Fetch the delivery with its parent webhook to verify ownership
  const delivery = await delegate.findUnique({
    where: { id: deliveryId },
    select: {
      id: true,
      status: true,
      attemptCount: true,
      lastAttemptAt: true,
      eventType: true,
      payload: true,
      webhook: {
        select: { id: true, userId: true, targetUrl: true, isActive: true },
      },
    },
  }) as (Record<string, unknown> & { webhook: Record<string, unknown> }) | null

  if (!delivery) {
    return NextResponse.json({ error: 'Webhook delivery not found.' }, { status: 404 })
  }

  // Ownership check — only the webhook owner can retry their deliveries.
  if ((delivery.webhook as Record<string, unknown>).userId !== user.id) {
    return NextResponse.json({ error: 'Webhook delivery not found.' }, { status: 404 })
  }

  if (delivery.status !== 'dead_lettered' && delivery.status !== 'failed') {
    return NextResponse.json(
      { error: `Only dead-lettered or failed deliveries can be retried. Current status: ${delivery.status}.` },
      { status: 409 },
    )
  }

  // Rate-limit manual retries per delivery to avoid hammering the target.
  if (delivery.lastAttemptAt) {
    const msSinceLast = Date.now() - new Date(delivery.lastAttemptAt as string).getTime()
    if (msSinceLast < MIN_RETRY_INTERVAL_MS) {
      const waitSec = Math.ceil((MIN_RETRY_INTERVAL_MS - msSinceLast) / 1000)
      return NextResponse.json(
        { error: `Retry too soon. Please wait ${waitSec}s before retrying.` },
        { status: 429 },
      )
    }
  }

  const now = new Date()
  const updated = await delegate.update({
    where: { id: deliveryId },
    data: {
      status: 'pending',
      nextRetryAt: now,
      lastAttemptAt: now,
      attemptCount: { increment: 1 },
    },
    select: {
      id: true,
      status: true,
      attemptCount: true,
      nextRetryAt: true,
      updatedAt: true,
    },
  })

  return NextResponse.json({
    message: 'Delivery queued for retry.',
    delivery: updated,
  })
}
