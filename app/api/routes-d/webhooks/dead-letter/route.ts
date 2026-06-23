import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// ── GET /api/routes-d/webhooks/dead-letter — list dead-letter queue entries ──
//
// Returns WebhookDelivery rows that have exhausted all retries (status = "dead").
// Only the owner's webhooks are included.

type DeliveryDelegate = {
  findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>
}

function getDeliveryDelegate(): DeliveryDelegate {
  return (prisma as unknown as { webhookDelivery: DeliveryDelegate }).webhookDelivery
}

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { searchParams } = new URL(request.url)
    const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') ?? '20', 10) || 20))

    // Join through UserWebhook to scope to this user's webhooks.
    const entries = await getDeliveryDelegate().findMany({
      where: {
        status: 'dead',
        webhook: { userId: user.id },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        webhookId: true,
        eventType: true,
        status: true,
        attemptCount: true,
        lastAttemptAt: true,
        lastStatusCode: true,
        lastError: true,
        createdAt: true,
      },
    })

    return NextResponse.json({ entries, page, limit })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/webhooks/dead-letter error')
    return NextResponse.json({ error: 'Failed to list dead-letter entries' }, { status: 500 })
  }
}
