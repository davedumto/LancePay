import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// Minimum interval between manual replays of the same delivery.
const MIN_REPLAY_INTERVAL_MS = 30_000

type WebhookDeliveryDelegate = {
  findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>
  create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
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

// POST /api/routes-d/webhooks/[id]/replay
//
// Re-enqueues a delivered or failed WebhookDelivery as a new pending delivery
// so the payload is dispatched again. Unlike /dead-letter/[id]/retry (which
// resets an existing row), replay creates a *new* delivery row so the audit
// trail of the original delivery is preserved.

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { id } = await params
    if (!id?.trim()) {
      return NextResponse.json({ error: 'Delivery ID is required' }, { status: 400 })
    }

    const delegate = getDeliveryDelegate()

    const original = await delegate.findUnique({
      where: { id: id.trim() },
      select: {
        id: true,
        status: true,
        eventType: true,
        payload: true,
        lastAttemptAt: true,
        webhook: {
          select: { id: true, userId: true, targetUrl: true, isActive: true },
        },
      },
    }) as (Record<string, unknown> & { webhook: Record<string, unknown> }) | null

    if (!original) {
      return NextResponse.json({ error: 'Webhook delivery not found' }, { status: 404 })
    }

    // Ownership — expose as 404 to avoid existence oracle.
    if ((original.webhook as Record<string, unknown>).userId !== user.id) {
      return NextResponse.json({ error: 'Webhook delivery not found' }, { status: 404 })
    }

    // Only completed deliveries (delivered or failed) can be replayed.
    const replayableStatuses = ['delivered', 'failed', 'dead_lettered']
    if (!replayableStatuses.includes(original.status as string)) {
      return NextResponse.json(
        {
          error: `Only delivered, failed, or dead-lettered deliveries can be replayed. Current status: ${original.status}.`,
        },
        { status: 409 },
      )
    }

    // Rate-limit replays per delivery to prevent hammering the target URL.
    if (original.lastAttemptAt) {
      const msSinceLast = Date.now() - new Date(original.lastAttemptAt as string).getTime()
      if (msSinceLast < MIN_REPLAY_INTERVAL_MS) {
        const waitSec = Math.ceil((MIN_REPLAY_INTERVAL_MS - msSinceLast) / 1000)
        return NextResponse.json(
          { error: `Replay too soon. Please wait ${waitSec}s before replaying.` },
          { status: 429 },
        )
      }
    }

    const replayed = await delegate.create({
      data: {
        webhookId: (original.webhook as Record<string, unknown>).id,
        eventType: original.eventType,
        payload: original.payload,
        status: 'pending',
        attemptCount: 0,
        nextRetryAt: new Date(),
      },
      select: {
        id: true,
        webhookId: true,
        eventType: true,
        status: true,
        attemptCount: true,
        nextRetryAt: true,
        createdAt: true,
      },
    })

    logger.info(
      { originalDeliveryId: original.id, newDeliveryId: replayed.id },
      'Webhook delivery replayed',
    )

    return NextResponse.json(
      { message: 'Delivery queued for replay.', delivery: replayed },
      { status: 201 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-d/webhooks/[id]/replay error')
    return NextResponse.json({ error: 'Failed to replay webhook delivery' }, { status: 500 })
  }
}
