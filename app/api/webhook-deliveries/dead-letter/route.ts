import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { isAdmin } from '@/lib/authorization'

/**
 * GET /api/webhook-deliveries/dead-letter
 *
 * Lists webhook deliveries that have exhausted their retry budget (dead-lettered).
 * A delivery is considered exhausted when:
 * - status is 'dead' or 'dead_lettered'
 * - nextRetryAt is null (no future retry scheduled)
 * - attemptCount >= 5 (max retry cap reached)
 *
 * Admin-only endpoint. Returns last-failure diagnostics (lastStatusCode, lastError)
 * for triage without opening each row.
 */
export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true, role: true },
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Admin-only access control
    if (!isAdmin(user)) {
      return NextResponse.json({ error: 'Forbidden: admin access required' }, { status: 403 })
    }

    const { searchParams } = new URL(request.url)
    const limitParam = searchParams.get('limit')
    const pageParam = searchParams.get('page')

    // Parse and validate limit (1-100, default 50)
    let limit = 50
    if (limitParam !== null) {
      limit = parseInt(limitParam, 10)
      if (isNaN(limit) || limit <= 0 || limit > 100) {
        return NextResponse.json(
          { error: 'Invalid limit parameter. Must be an integer between 1 and 100.' },
          { status: 400 }
        )
      }
    }

    // Parse and validate page (default 1)
    let page = 1
    if (pageParam !== null) {
      page = parseInt(pageParam, 10)
      if (isNaN(page) || page <= 0) {
        return NextResponse.json(
          { error: 'Invalid page parameter. Must be a positive integer.' },
          { status: 400 }
        )
      }
    }

    const offset = (page - 1) * limit

    // Filter to only genuinely exhausted deliveries:
    // - status must be 'dead' or 'dead_lettered' (explicit terminal status)
    // - nextRetryAt must be null (no more retries scheduled)
    // - status must not be 'delivered' or 'succeeded' (delivery succeeded = not dead-letter)
    const whereClause = {
      AND: [
        {
          status: {
            in: ['dead', 'dead_lettered'],
          },
        },
        {
          nextRetryAt: null,
        },
      ],
    }

    const db = prisma as unknown as {
      webhookDelivery: {
        findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>
        count: (args: Record<string, unknown>) => Promise<number>
      }
    }

    // Query dead-letter deliveries with pagination
    const [deliveries, totalCount] = await Promise.all([
      db.webhookDelivery.findMany({
        where: whereClause,
        take: limit,
        skip: offset,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          webhookId: true,
          eventType: true,
          payload: true,
          status: true,
          attemptCount: true,
          lastAttemptAt: true,
          nextRetryAt: true,
          lastStatusCode: true,
          lastError: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      db.webhookDelivery.count({ where: whereClause }),
    ])

    // Transform response payload
    const deadLetterDeliveries = deliveries.map((d) => ({
      id: d.id,
      webhookId: d.webhookId,
      eventType: d.eventType,
      payload: d.payload,
      status: d.status,
      attemptCount: d.attemptCount,
      lastAttemptAt: d.lastAttemptAt,
      nextRetryAt: d.nextRetryAt,
      lastStatusCode: d.lastStatusCode,
      lastError: d.lastError,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    }))

    logger.info(
      { adminId: user.id, count: deadLetterDeliveries.length, total: totalCount, page, limit },
      'GET /api/webhook-deliveries/dead-letter succeeded'
    )

    return NextResponse.json({
      deliveries: deadLetterDeliveries,
      total: totalCount,
      page,
      limit,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/webhook-deliveries/dead-letter error')
    return NextResponse.json({ error: 'Failed to fetch dead-letter deliveries' }, { status: 500 })
  }
}
