import { withRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import {
  getCachedUnreadCount,
  setCachedUnreadCount,
} from '../../_lib/notification-cache'

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

  const count = await prisma.notification.count({
    where: { userId: user.id, isRead: false },
  })

  setCachedUnreadCount(user.id, count)

  return NextResponse.json({ count })
}

export const GET = withRequestId(GETHandler)
