import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { isAdmin } from '@/lib/authorization'

const MAX_BATCH_SIZE = 50

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })
    if (!isAdmin(user)) {
      return NextResponse.json({ error: 'Forbidden: admin access required' }, { status: 403 })
    }

    const body = await request.json().catch(() => ({}))
    const { deliveryIds } = body

    if (!Array.isArray(deliveryIds) || deliveryIds.length === 0) {
      return NextResponse.json(
        { error: 'deliveryIds must be a non-empty array' },
        { status: 400 },
      )
    }

    if (deliveryIds.length > MAX_BATCH_SIZE) {
      return NextResponse.json(
        { error: `Batch size exceeds maximum of ${MAX_BATCH_SIZE}` },
        { status: 400 },
      )
    }

    const invalidIds = deliveryIds.filter((id) => typeof id !== 'string' || id.trim().length === 0)
    if (invalidIds.length > 0) {
      return NextResponse.json(
        { error: 'All deliveryIds must be non-empty strings' },
        { status: 400 },
      )
    }

    const deliveries = await prisma.webhookDelivery.findMany({
      where: { id: { in: deliveryIds } },
      include: { webhook: { select: { userId: true, targetUrl: true, signingSecret: true } } },
    })

    const found = new Set(deliveries.map((d) => d.id))
    const notFound = deliveryIds.filter((id: string) => !found.has(id))

    const results = await Promise.all(
      deliveries.map(async (delivery) => {
        try {
          await prisma.webhookDelivery.update({
            where: { id: delivery.id },
            data: {
              status: 'pending',
              attemptCount: 0,
              lastAttemptAt: null,
              nextRetryAt: new Date(),
              lastError: null,
            },
          })
          return { id: delivery.id, status: 'queued' as const }
        } catch {
          return { id: delivery.id, status: 'error' as const, reason: 'DB update failed' }
        }
      }),
    )

    logger.info(
      { adminId: user.id, batchSize: deliveries.length, notFound },
      'Webhook replay-batch triggered',
    )

    return NextResponse.json({
      queued: results.filter((r) => r.status === 'queued').length,
      failed: results.filter((r) => r.status === 'error').length,
      notFound,
      results,
      replayedBy: user.email,
      replayedAt: new Date().toISOString(),
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-d/admin/webhooks/replay-batch error')
    return NextResponse.json({ error: 'Failed to replay webhook deliveries' }, { status: 500 })
  }
}
