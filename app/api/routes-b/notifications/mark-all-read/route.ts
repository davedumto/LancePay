import { withRequestId, getRequestId } from '../../_lib/with-request-id'
import { withMethods } from '../../_lib/with-methods'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { checkRateLimit } from '../../_lib/rate-limit'
import { bustUnreadCountCache } from '../../_lib/notification-cache'
import { errorResponse } from '../../_lib/errors'
import { logger } from '@/lib/logger'

async function POSTHandler(request: NextRequest) {
  const requestId = getRequestId()

  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) {
      return errorResponse('UNAUTHORIZED', 'Unauthorized', { requestId }, 401)
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return errorResponse('UNAUTHORIZED', 'Invalid token', { requestId }, 401)
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })
    if (!user) {
      return errorResponse('NOT_FOUND', 'User not found', { requestId }, 404)
    }

    const rateLimit = checkRateLimit(`notifications:mark-all-read:${user.id}`, {
      limit: 5,
      windowMs: 60_000,
    })

    if (!rateLimit.allowed) {
      const response = errorResponse('RATE_LIMITED', 'Too many requests', { requestId }, 429)
      response.headers.set('Retry-After', String(rateLimit.retryAfter))
      return response
    }

    const result = await prisma.notification.updateMany({
      where: { userId: user.id, isRead: false },
      data: { isRead: true },
    })

    bustUnreadCountCache(user.id)

    return NextResponse.json({ updated: result.count })
  } catch (error) {
    logger.error({ err: error }, 'Routes-B notifications/mark-all-read POST error')
    return errorResponse(
      'INTERNAL',
      'Failed to mark notifications as read',
      { requestId },
      500,
    )
  }
}

export const { POST } = withMethods({
  POST: withRequestId(POSTHandler),
})
