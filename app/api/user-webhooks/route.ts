import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
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

const DEFAULT_SUBSCRIBED_EVENTS = ['invoice.paid']
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
 * GET /api/user-webhooks
 *
 * Lists all webhook subscriptions owned by the authenticated user.
 * `signingSecret` and `previousSigningSecret` are never returned here.
 */
export async function GET(request: NextRequest) {
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

    const rows = await prisma.userWebhook.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    })

    const webhooks = rows.map((wh) => ({
      id: wh.id,
      userId: wh.userId,
      targetUrl: wh.targetUrl,
      description: wh.description ?? null,
      isActive: wh.isActive,
      subscribedEvents: wh.subscribedEvents,
      status: wh.status,
      consecutiveFailures: wh.consecutiveFailures,
      lastTriggeredAt: wh.lastTriggeredAt ?? null,
      lastFailureAt: wh.lastFailureAt ?? null,
      createdAt: wh.createdAt,
    }))

    return NextResponse.json({ webhooks }, { status: 200 })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/user-webhooks error')
    return NextResponse.json(
      { error: 'Failed to list user webhooks' },
      { status: 500 },
    )
  }
}

/**
 * POST /api/user-webhooks
 *
 * Creates a new `UserWebhook` subscription for the authenticated user.
 *
 * - Validates `targetUrl` is a well-formed http/https URL (max 512 chars).
 * - Validates `subscribedEvents` against the allowed event set (defaults to `['invoice.paid']`).
 * - Generates a CSPRNG 32-byte hex `signingSecret` server-side and returns it
 *   **once** in the 201 creation response.
 */
export async function POST(request: NextRequest) {
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

    let body: Record<string, unknown>
    try {
      body = (await request.json()) as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    if (!body.targetUrl || typeof body.targetUrl !== 'string') {
      return NextResponse.json({ error: 'targetUrl is required' }, { status: 400 })
    }

    const trimmedUrl = body.targetUrl.trim()
    if (!isValidTargetUrl(trimmedUrl)) {
      return NextResponse.json(
        { error: 'targetUrl must be a valid http or https URL (max 512 chars)' },
        { status: 400 },
      )
    }

    let subscribedEvents: string[] = DEFAULT_SUBSCRIBED_EVENTS
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
      subscribedEvents = Array.from(new Set(body.subscribedEvents as string[]))
    }

    let description: string | null = null
    if (body.description !== undefined && body.description !== null) {
      if (
        typeof body.description !== 'string' ||
        body.description.length > MAX_DESCRIPTION_LENGTH
      ) {
        return NextResponse.json(
          {
            error: `description must be a string of at most ${MAX_DESCRIPTION_LENGTH} characters`,
          },
          { status: 400 },
        )
      }
      description = body.description
    }

    const signingSecret = crypto.randomBytes(32).toString('hex')

    const created = await prisma.userWebhook.create({
      data: {
        userId: user.id,
        targetUrl: trimmedUrl,
        description,
        subscribedEvents,
        signingSecret,
        isActive: true,
        status: 'ACTIVE',
      },
    })

    logger.info(
      { userId: user.id, webhookId: created.id, subscribedEvents },
      'User webhook subscription created',
    )

    const responsePayload = {
      id: created.id,
      userId: created.userId ?? user.id,
      targetUrl: created.targetUrl ?? trimmedUrl,
      description: created.description ?? description,
      subscribedEvents: created.subscribedEvents ?? subscribedEvents,
      isActive: created.isActive ?? true,
      status: created.status ?? 'ACTIVE',
      signingSecret,
      createdAt: created.createdAt,
    }

    return NextResponse.json(
      {
        ...responsePayload,
        webhook: responsePayload,
      },
      { status: 201 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/user-webhooks error')
    return NextResponse.json(
      { error: 'Failed to create user webhook subscription' },
      { status: 500 },
    )
  }
}
