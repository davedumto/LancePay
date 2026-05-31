import { withRequestId } from '../_lib/with-request-id'
import { withMethods } from '../_lib/with-methods'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { isNotificationSnoozed } from '../_lib/notification-snooze'
import { decodeCursor, encodeCursor } from '../_lib/cursor'
import { buildLinkHeader } from '../_lib/link-header'

async function GETHandler(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const { searchParams } = new URL(request.url)
    const unreadOnly = searchParams.get('unread') === 'true'

    const limit = Math.min(
      100,
      Math.max(1, Number.parseInt(searchParams.get('limit') || '25', 10) || 25),
    )

    const cursorParam = searchParams.get('cursor')
    const decodedCursor = cursorParam ? decodeCursor(cursorParam) : null

    if (cursorParam && !decodedCursor) {
      return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 })
    }

    const where = {
      userId: user.id,
      ...(unreadOnly ? { isRead: false } : {}),
      ...(decodedCursor
        ? {
            OR: [
              {
                createdAt: {
                  lt: new Date(decodedCursor.createdAt),
                },
              },
              {
                AND: [
                  {
                    createdAt: new Date(decodedCursor.createdAt),
                  },
                  {
                    id: {
                      lt: decodedCursor.id,
                    },
                  },
                ],
              },
            ],
          }
        : {}),
    }

    const notifications = await prisma.notification.findMany({
      where,
      orderBy: [
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
      take: limit + 1,
      select: {
        id: true,
        type: true,
        title: true,
        message: true,
        isRead: true,
        createdAt: true,
      },
    })

    const hasNext = notifications.length > limit
    const page = hasNext
      ? notifications.slice(0, limit)
      : notifications

    const last = page[page.length - 1]
    const nextCursor = hasNext && last
      ? encodeCursor({
          createdAt: last.createdAt.toISOString(),
          id: last.id,
        })
      : null

    const visibleNotifications = page.filter(
      n => !isNotificationSnoozed(n.id),
    )

    const unreadCount = visibleNotifications.filter(n => !n.isRead).length

    const response = NextResponse.json({
      notifications: visibleNotifications,
      unreadCount,
      nextCursor,
    })

    const linkHeader = buildLinkHeader(request.url, nextCursor)
    if (linkHeader) {
      response.headers.set('Link', linkHeader)
    }

    return response
  } catch (error) {
    logger.error({ err: error }, 'Routes B notifications GET error')
    return NextResponse.json({ error: 'Failed to get notifications' }, { status: 500 })
  }
}

export const { GET } = withMethods({
  GET: withRequestId(GETHandler),
})