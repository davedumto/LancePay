import { withRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { checkRateLimit } from '../../_lib/rate-limit'
import { bustUnreadCountCache } from '../../_lib/notification-cache'

async function POSTHandler(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const rateLimit = checkRateLimit(`notifications:mark-all-read:${user.id}`, {
    limit: 5,
    windowMs: 60_000,
  })

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: 'Too many requests' },
      {
        status: 429,
        headers: { 'Retry-After': String(rateLimit.retryAfter) },
      },
    )
  }

  const result = await prisma.notification.updateMany({
    where: { userId: user.id, isRead: false },
    data: { isRead: true },
  })

  bustUnreadCountCache(user.id)

  return NextResponse.json({ updated: result.count })
}

export const POST = withRequestId(POSTHandler)
