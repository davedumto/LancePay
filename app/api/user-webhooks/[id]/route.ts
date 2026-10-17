import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export const ALLOWED_WEBHOOK_EVENTS = new Set([
  'invoice.created',
  'invoice.paid',
  'invoice.overdue',
  'invoice.cancelled',
  'invoice.sent',
  'invoice.viewed',
  'payment.received',
  'payment.completed',
  'payment.failed',
  'transfer.completed',
  'transfer.failed',
  'withdrawal.created',
  'withdrawal.completed',
  'withdrawal.failed',
  'escrow.funded',
  'escrow.released',
  'escrow.disputed',
  'escrow.refunded',
  'subscription.created',
  'subscription.cancelled',
  'subscription.renewed',
  'kyc.submitted',
  'kyc.approved',
  'kyc.rejected',
  'api_key.created',
  'api_key.revoked',
  'reconciliation.matched',
  '*',
])

const MAX_TARGET_URL_LENGTH = 512
const MAX_DESCRIPTION_LENGTH = 100

function isValidTargetUrl(rawUrl: string): boolean {
  if (!rawUrl || rawUrl.length > MAX_TARGET_URL_LENGTH) return false
  try {
    const parsed = new URL(rawUrl)
    return (
      (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      Boolean(parsed.hostname)
    )
  } catch {
    return false
  }
}

/**
 * PATCH /api/user-webhooks/[id]
 *
 * Updates a webhook subscription's `targetUrl`, `subscribedEvents`, `isActive`,
 * or `description`.
 *
 * Direct modification of `signingSecret` (or grace-window fields
 * `previousSigningSecret` / `signingSecretExpiresAt`) is explicitly rejected
 * with 400 Bad Request — secret rotation must go through
 * `PATCH /api/user-webhooks/[id]/rotate-signing-secret`.
 */
export async function PATCH(
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

    let body: Record<string, unknown>
    try {
      body = (await request.json()) as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    // Explicitly forbid direct modification of signingSecret or rotation fields
    if (
      'signingSecret' in body ||
      'previousSigningSecret' in body ||
      'signingSecretExpiresAt' in body
    ) {
      return NextResponse.json(
        {
          error:
            'signingSecret cannot be updated via PATCH; use /api/user-webhooks/[id]/rotate-signing-secret',
        },
        { status: 400 },
      )
    }

    const webhook = await prisma.userWebhook.findUnique({ where: { id } })
    if (!webhook) {
      return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })
    }

    if (webhook.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const updateData: Record<string, unknown> = {}

    if (body.targetUrl !== undefined) {
      if (typeof body.targetUrl !== 'string' || !isValidTargetUrl(body.targetUrl.trim())) {
        return NextResponse.json(
          { error: 'targetUrl must be a valid http or https URL (max 512 chars)' },
          { status: 400 },
        )
      }
      updateData.targetUrl = body.targetUrl.trim()
    }

    if (body.subscribedEvents !== undefined) {
      if (
        !Array.isArray(body.subscribedEvents) ||
        body.subscribedEvents.length === 0 ||
        !body.subscribedEvents.every(
          (ev) => typeof ev === 'string' && ALLOWED_WEBHOOK_EVENTS.has(ev),
        )
      ) {
        return NextResponse.json(
          {
            error:
              'subscribedEvents must be a non-empty array of valid webhook event types',
          },
          { status: 400 },
        )
      }
      updateData.subscribedEvents = Array.from(new Set(body.subscribedEvents as string[]))
    }

    if (body.isActive !== undefined) {
      if (typeof body.isActive !== 'boolean') {
        return NextResponse.json(
          { error: 'isActive must be a boolean' },
          { status: 400 },
        )
      }
      updateData.isActive = body.isActive
      updateData.status = body.isActive ? 'ACTIVE' : 'INACTIVE'
      if (body.isActive) {
        updateData.consecutiveFailures = 0
      }
    }

    if (body.description !== undefined) {
      if (
        body.description !== null &&
        (typeof body.description !== 'string' ||
          body.description.length > MAX_DESCRIPTION_LENGTH)
      ) {
        return NextResponse.json(
          { error: `description must be a string of at most ${MAX_DESCRIPTION_LENGTH} characters or null` },
          { status: 400 },
        )
      }
      updateData.description = body.description
    }

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json(
        {
          error:
            'At least one updatable field (targetUrl, subscribedEvents, isActive, description) must be provided',
        },
        { status: 400 },
      )
    }

    const updated = await prisma.userWebhook.update({
      where: { id },
      data: updateData,
    })

    const safeWebhook = {
      id: updated.id,
      userId: updated.userId,
      targetUrl: updated.targetUrl,
      description: updated.description ?? null,
      isActive: updated.isActive,
      subscribedEvents: updated.subscribedEvents,
      status: updated.status,
      consecutiveFailures: updated.consecutiveFailures,
      lastTriggeredAt: updated.lastTriggeredAt ?? null,
      lastFailureAt: updated.lastFailureAt ?? null,
      createdAt: updated.createdAt,
    }

    logger.info(
      { userId: user.id, webhookId: id, updatedFields: Object.keys(updateData) },
      'Webhook subscription updated',
    )

    return NextResponse.json(
      {
        ...safeWebhook,
        webhook: safeWebhook,
      },
      { status: 200 },
    )
  } catch (error) {
    logger.error({ err: error }, 'PATCH /api/user-webhooks/[id] error')
    return NextResponse.json(
      { error: 'Failed to update webhook subscription' },
      { status: 500 },
    )
  }
}

/**
 * DELETE /api/user-webhooks/[id]
 *
 * Deletes a webhook subscription owned by the authenticated user and cleans up
 * associated delivery records.
 */
export async function DELETE(
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

    // Explicitly clean up pending/historical deliveries before deleting the webhook
    if (prisma.webhookDelivery?.deleteMany) {
      await prisma.webhookDelivery.deleteMany({ where: { webhookId: id } })
    }
    await prisma.userWebhook.delete({ where: { id } })

    logger.info({ userId: user.id, webhookId: id }, 'Webhook subscription deleted')

    return NextResponse.json(
      {
        id,
        deleted: true,
        removed: true,
      },
      { status: 200 },
    )
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/user-webhooks/[id] error')
    return NextResponse.json(
      { error: 'Failed to delete webhook subscription' },
      { status: 500 },
    )
  }
}
