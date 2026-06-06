import { withRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import {
  getCachedUnreadCount,
  setCachedUnreadCount,
} from '../../_lib/notification-cache'
import { isNotificationSnoozed } from '../../_lib/notification-snooze'

async function GETHandler(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const cached = getCachedUnreadCount(user.id)
  if (cached !== null) {
    return NextResponse.json({ count: cached })
  }

  const unreadNotifications = await prisma.notification.findMany({
    where: { userId: user.id, isRead: false },
    select: { id: true },
  })

  const count = unreadNotifications.filter(n => !isNotificationSnoozed(n.id)).length

  setCachedUnreadCount(user.id, count)

  return NextResponse.json({ count })
}

export const GET = withRequestId(GETHandler)
