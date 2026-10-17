import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const ALLOWED_STATUSES = new Set([
  'pending',
  'delivered',
  'failed',
  'dead',
  'dead_lettered',
])

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

/**
 * GET /api/user-webhooks/[id]/deliveries
 *
 * Lists paginated delivery history for a specific user webhook.
 *
 * Query parameters:
 *   - status    (optional): filter by delivery status ('pending' | 'delivered' | 'failed' | 'dead' | 'dead_lettered')
 *   - eventType (optional): filter by eventType (e.g. 'invoice.paid')
 *   - page      (optional): 1-indexed page number (default 1)
 *   - limit     (optional): page size between 1 and 100 (default 20)
 *   - cursor    (optional): delivery ID cursor for cursor-based pagination
 *
 * Access is restricted to the webhook owner (or an admin). The webhook's
 * signingSecret is never returned.
 */
export async function GET(
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

    const { searchParams } = new URL(request.url)
    const statusParam = searchParams.get('status')
    const eventTypeParam = searchParams.get('eventType')
    const limitParam = searchParams.get('limit')
    const pageParam = searchParams.get('page')
    const cursorParam = searchParams.get('cursor')

    if (statusParam !== null && statusParam !== '') {
      if (!ALLOWED_STATUSES.has(statusParam)) {
        return NextResponse.json(
          {
            error: `Invalid status filter. Allowed values: ${Array.from(ALLOWED_STATUSES).join(', ')}`,
          },
          { status: 400 },
        )
      }
    }

    let limit = DEFAULT_LIMIT
    if (limitParam !== null) {
      const parsedLimit = Number(limitParam)
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_LIMIT) {
        return NextResponse.json(
          { error: `limit must be an integer between 1 and ${MAX_LIMIT}` },
          { status: 400 },
        )
      }
      limit = parsedLimit
    }

    let page = 1
    if (pageParam !== null) {
      const parsedPage = Number(pageParam)
      if (!Number.isInteger(parsedPage) || parsedPage < 1) {
        return NextResponse.json(
          { error: 'page must be a positive integer' },
          { status: 400 },
        )
      }
      page = parsedPage
    }

    const where: Record<string, unknown> = { webhookId: id }
    if (statusParam) {
      where.status = statusParam
    }
    if (eventTypeParam) {
      where.eventType = eventTypeParam
    }

    const findManyArgs: Record<string, unknown> = {
      where,
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        webhookId: true,
        eventType: true,
        payload: true,
        status: true,
        attemptCount: true,
        lastStatusCode: true,
        lastError: true,
        lastAttemptAt: true,
        nextRetryAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }

    if (cursorParam) {
      findManyArgs.cursor = { id: cursorParam }
      findManyArgs.skip = 1
    } else {
      findManyArgs.skip = (page - 1) * limit
    }

    const [deliveries, total] = await Promise.all([
      prisma.webhookDelivery.findMany(findManyArgs as any),
      prisma.webhookDelivery.count({ where } as any),
    ])

    const totalPages = total === 0 ? 0 : Math.ceil(total / limit)
    const hasMore = cursorParam
      ? deliveries.length === limit
      : page * limit < total
    const nextCursor =
      hasMore && deliveries.length > 0
        ? deliveries[deliveries.length - 1].id
        : null

    logger.info(
      {
        userId: user.id,
        webhookId: id,
        status: statusParam ?? null,
        count: deliveries.length,
        total,
        page,
        limit,
      },
      'GET /api/user-webhooks/[id]/deliveries succeeded',
    )

    return NextResponse.json(
      {
        webhookId: id,
        deliveries,
        total,
        page,
        limit,
        totalPages,
        hasMore,
        nextCursor,
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasMore,
          nextCursor,
        },
      },
      { status: 200 },
    )
  } catch (error) {
    logger.error({ err: error }, 'GET /api/user-webhooks/[id]/deliveries error')
    return NextResponse.json(
      { error: 'Failed to fetch webhook deliveries' },
      { status: 500 },
    )
  }
}
