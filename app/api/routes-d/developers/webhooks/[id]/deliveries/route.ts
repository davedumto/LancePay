import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAuthContext } from '@/app/api/routes-d/disputes/_shared'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: webhookId } = await params
    const auth = await getAuthContext(request)
    if ('error' in auth) {
      return NextResponse.json({ error: auth.error }, { status: 401 })
    }

    const webhook = await prisma.userWebhook.findFirst({
      where: { id: webhookId, userId: auth.user.id },
      select: { id: true },
    })

    if (!webhook) {
      return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })
    }

    const deliveries = await prisma.webhookDelivery.findMany({
      where: { webhookId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        eventType: true,
        status: true,
        attemptCount: true,
        lastAttemptAt: true,
        nextRetryAt: true,
        lastStatusCode: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    return NextResponse.json({ deliveries })
  } catch (error) {
    console.error('Webhook deliveries GET error:', error)
    return NextResponse.json({ error: 'Failed to fetch webhook deliveries' }, { status: 500 })
  }
}
