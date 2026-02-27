import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAuthContext } from '@/app/api/routes-d/disputes/_shared'
import { manualRetry } from '@/lib/webhooks'

/**
 * POST /api/routes-d/notifications/webhooks/[id]/retry
 * Manually retry a failed webhook delivery
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: webhookId } = await params
    const auth = await getAuthContext(request)
    if ('error' in auth) {
      return NextResponse.json({ error: auth.error }, { status: 401 })
    }

    // Verify webhook belongs to user
    const webhook = await prisma.userWebhook.findFirst({
      where: { id: webhookId, userId: auth.user.id },
    })

    if (!webhook) {
      return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })
    }

    const body = await request.json()
    const { deliveryId } = body

    if (!deliveryId) {
      return NextResponse.json({ error: 'deliveryId is required' }, { status: 400 })
    }

    // Verify delivery belongs to this webhook
    const delivery = await prisma.webhookDelivery.findFirst({
      where: { id: deliveryId, webhookId },
    })

    if (!delivery) {
      return NextResponse.json({ error: 'Delivery not found' }, { status: 404 })
    }

    const result = await manualRetry(deliveryId)

    return NextResponse.json({
      success: result.success,
      statusCode: result.statusCode,
      error: result.error,
      responseTime: result.responseTime,
    })
  } catch (error) {
    console.error('Manual retry error:', error)
    return NextResponse.json(
      { error: 'Failed to retry delivery' },
      { status: 500 }
    )
  }
}
