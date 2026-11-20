import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { sendWebhookDisabledEmail } from '@/lib/email'
import {
  WEBHOOK_RETRY_CONFIG,
  attemptWebhookDelivery,
  computeNextRetryDelayMs,
} from '@/lib/webhook-delivery'

// Bounded per run: due deliveries are claimed with a conditional update so
// overlapping cron invocations can't double-deliver, and exponential
// backoff (shared with the manual replay path) schedules retries.
const BATCH_SIZE = Number(process.env.WEBHOOK_RETRY_CRON_BATCH_SIZE ?? 50)
const MAX_BATCHES = Number(process.env.WEBHOOK_RETRY_CRON_MAX_BATCHES ?? 10)

/**
 * GET /api/cron/process-webhook-retries
 *
 * Picks up WebhookDelivery rows that are pending/failed and due
 * (nextRetryAt null or in the past), attempts delivery, applies
 * exponential backoff on failure, dead-letters after maxAttempts, and
 * auto-disables webhooks that hit the consecutive-failure threshold.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const now = new Date()
  let attempted = 0
  let delivered = 0
  let deadLettered = 0
  let disabled = 0
  let batches = 0

  try {
    while (batches < MAX_BATCHES) {
      const due = await prisma.webhookDelivery.findMany({
        where: {
          status: { in: ['pending', 'failed'] },
          OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
        },
        include: {
          webhook: {
            include: {
              user: { select: { email: true, name: true } },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
        take: BATCH_SIZE,
      })
      if (due.length === 0) break
      batches++

      for (const delivery of due) {
        // Claim the delivery atomically — a concurrent runner or a manual
        // replay that already moved it out of pending/failed makes this a
        // no-op.
        const claimed = await prisma.webhookDelivery.updateMany({
          where: {
            id: delivery.id,
            status: { in: ['pending', 'failed'] },
            OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
          },
          data: {
            attemptCount: { increment: 1 },
            lastAttemptAt: now,
            nextRetryAt: null,
          },
        })
        if (claimed.count === 0) continue
        attempted++

        const attempt = await attemptWebhookDelivery({
          payload: delivery.payload,
          targetUrl: delivery.webhook.targetUrl,
          signingSecret: delivery.webhook.signingSecret,
          eventType: delivery.eventType,
        })

        const newAttemptCount = delivery.attemptCount + 1
        const isDeadLetter =
          !attempt.success && newAttemptCount >= WEBHOOK_RETRY_CONFIG.maxAttempts
        const nextRetryAt =
          !attempt.success && !isDeadLetter
            ? new Date(Date.now() + computeNextRetryDelayMs(newAttemptCount - 1))
            : null

        const newConsecutiveFailures = attempt.success
          ? 0
          : delivery.webhook.consecutiveFailures + 1
        const shouldDisableWebhook =
          !attempt.success &&
          newConsecutiveFailures >= WEBHOOK_RETRY_CONFIG.consecutiveFailuresThreshold

        await prisma.$transaction(async (tx) => {
          await tx.webhookDelivery.update({
            where: { id: delivery.id },
            data: {
              status: attempt.success
                ? 'delivered'
                : isDeadLetter
                  ? 'dead_lettered'
                  : 'failed',
              attemptCount: newAttemptCount,
              lastAttemptAt: new Date(),
              lastStatusCode: attempt.statusCode,
              lastError: attempt.error,
              nextRetryAt,
            },
          })

          await tx.userWebhook.update({
            where: { id: delivery.webhookId },
            data: {
              consecutiveFailures: newConsecutiveFailures,
              lastFailureAt: attempt.success
                ? delivery.webhook.lastFailureAt
                : new Date(),
              ...(shouldDisableWebhook
                ? { status: 'INACTIVE', isActive: false }
                : {}),
            },
          })
        })

        if (attempt.success) delivered++
        if (isDeadLetter) deadLettered++
        if (shouldDisableWebhook) {
          disabled++
          try {
            await sendWebhookDisabledEmail({
              to: delivery.webhook.user.email,
              userName: delivery.webhook.user.name || 'User',
              webhookUrl: delivery.webhook.targetUrl,
              lastError: attempt.error || 'Multiple consecutive failures',
              autoDisabled: true,
            })
          } catch (emailError) {
            console.error('Failed to send webhook disabled email:', emailError)
          }
        }
      }

      if (due.length < BATCH_SIZE) break
    }

    return NextResponse.json({ attempted, delivered, deadLettered, disabled, batches })
  } catch (error) {
    console.error('Fatal error processing webhook retries:', error)
    return NextResponse.json(
      { error: 'Internal server error processing webhook retries' },
      { status: 500 },
    )
  }
}
