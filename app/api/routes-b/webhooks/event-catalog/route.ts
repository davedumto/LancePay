import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { VALID_EVENT_TYPES } from '@/app/api/routes-b/_lib/webhook-events'

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Return the list of valid webhook event types
    return NextResponse.json({ eventTypes: VALID_EVENT_TYPES })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-b/webhooks/event-catalog error')
    return NextResponse.json({ error: 'Failed to retrieve webhook event catalog' }, { status: 500 })
  }
}
