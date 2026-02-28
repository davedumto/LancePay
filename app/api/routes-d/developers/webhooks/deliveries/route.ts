import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAuthContext } from '@/app/api/routes-d/disputes/_shared'

export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthContext(request)
    if ('error' in auth) {
      return NextResponse.json({ error: auth.error }, { status: 401 })
    }

    const webhookId = request.nextUrl.searchParams.get('webhookId')

    if (webhookId) {
      const webhook = await prisma.userWebhook.findFirst({
        where: {
          id: webhookId,
          userId: auth.user.id,
        },
        select: { id: true },
      })

      if (!webhook) {
        return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })
      }
    }

    const deliveries = await prisma.webhookDelivery.findMany({
      where: {
        webhook: { userId: auth.user.id },
        ...(webhookId ? { webhookId } : {}),
      },
      select: {
        id: true,
        webhookId: true,
        eventType: true,
        status: true,
        attemptCount: true,
        lastAttemptAt: true,
        nextRetryAt: true,
        lastStatusCode: true,
        lastError: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })

    return NextResponse.json({
      deliveries: deliveries.map((delivery) => ({
        id: delivery.id,
        webhookId: delivery.webhookId,
        eventType: delivery.eventType,
        status: delivery.status,
        attempts: delivery.attemptCount,
        lastAttemptAt: delivery.lastAttemptAt,
        nextRetryAt: delivery.nextRetryAt,
        lastStatusCode: delivery.lastStatusCode,
        lastError: delivery.lastError,
        createdAt: delivery.createdAt,
      })),
    })
  } catch (error) {
    console.error('Webhook deliveries GET error:', error)
    return NextResponse.json({ error: 'Failed to fetch webhook deliveries' }, { status: 500 })
  }
}
