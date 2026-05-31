import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

type NotificationCursor = {
  createdAt: string
  id: string
}

function encodeCursor(payload: NotificationCursor): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string): NotificationCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as NotificationCursor

    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.createdAt !== 'string' ||
      typeof parsed.id !== 'string'
    ) {
      return null
    }

    const createdAt = new Date(parsed.createdAt)
    if (Number.isNaN(createdAt.getTime())) {
      return null
    }

    return { createdAt: createdAt.toISOString(), id: parsed.id }
  } catch {
    return null
  }
}

function parseLimit(rawLimit: string | null): number {
  if (!rawLimit) return DEFAULT_LIMIT

  const parsed = Number.parseInt(rawLimit, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT

  return Math.min(parsed, MAX_LIMIT)
}

// ── GET /api/routes-d/notifications — list notifications for current user ──

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    // Check for ?unread=true filter
    const { searchParams } = new URL(request.url)
    const unreadOnly = searchParams.get('unread') === 'true'
    const limit = parseLimit(searchParams.get('limit'))
    const cursorParam = searchParams.get('cursor')
    const decodedCursor = cursorParam ? decodeCursor(cursorParam) : null

    if (cursorParam && !decodedCursor) {
      return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 })
    }

    const where: any = { userId: user.id }
    if (unreadOnly) {
      where.isRead = false
    }
    if (decodedCursor) {
      where.OR = [
        { createdAt: { lt: new Date(decodedCursor.createdAt) } },
        {
          AND: [
            { createdAt: new Date(decodedCursor.createdAt) },
            { id: { lt: decodedCursor.id } },
          ],
        },
      ]
    }

    const notifications = await prisma.notification.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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
    const page = hasNext ? notifications.slice(0, limit) : notifications
    const last = page[page.length - 1]
    const nextCursor = hasNext && last
      ? encodeCursor({
          createdAt: last.createdAt.toISOString(),
          id: last.id,
        })
      : null

    const unreadCount = await prisma.notification.count({
      where: { userId: user.id, isRead: false },
    })

    return NextResponse.json({
      notifications: page,
      unreadCount,
      nextCursor,
    })
  } catch (error) {
    logger.error({ err: error }, 'Notifications GET error')
    return NextResponse.json({ error: 'Failed to get notifications' }, { status: 500 })
  }
}
