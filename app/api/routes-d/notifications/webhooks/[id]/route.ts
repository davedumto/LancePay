import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAuthContext } from '@/app/api/routes-d/disputes/_shared'
import { logger } from '@/lib/logger'

/**
 * DELETE /api/routes-d/notifications/webhooks/[id]
 * Delete a webhook configuration
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const auth = await getAuthContext(request)
    if ('error' in auth) {
      return NextResponse.json({ error: auth.error }, { status: 401 })
    }

    // Verify webhook belongs to user
    const webhook = await prisma.userWebhook.findFirst({
      where: {
        id,
        userId: auth.user.id,
      },
    })

    if (!webhook) {
      return NextResponse.json(
        { error: 'Webhook not found' },
        { status: 404 }
      )
    }

    // Delete webhook
    await prisma.userWebhook.delete({
      where: { id },
    })

    return NextResponse.json({ success: true, message: 'Webhook deleted successfully' })
  } catch (error) {
    logger.error({ err: error }, 'Webhook deletion error:')
    return NextResponse.json(
      { error: 'Failed to delete webhook' },
      { status: 500 }
    )
  }
}

/**
 * PATCH /api/routes-d/notifications/webhooks/[id]
 * Re-enable a disabled webhook
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const auth = await getAuthContext(request)
    if ('error' in auth) {
      return NextResponse.json({ error: auth.error }, { status: 401 })
    }

    const webhook = await prisma.userWebhook.findFirst({
      where: { id, userId: auth.user.id },
    })

    if (!webhook) {
      return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })
    }

    const body = await request.json()

    if (body.action === 'reactivate') {
      const updated = await prisma.userWebhook.update({
        where: { id },
        data: {
          status: 'ACTIVE',
          isActive: true,
          consecutiveFailures: 0,
        },
        select: {
          id: true,
          targetUrl: true,
          description: true,
          isActive: true,
          status: true,
          consecutiveFailures: true,
          subscribedEvents: true,
          lastTriggeredAt: true,
          lastFailureAt: true,
          createdAt: true,
        },
      })

      return NextResponse.json({ success: true, webhook: updated })
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (error) {
    console.error('Webhook PATCH error:', error)
    return NextResponse.json(
      { error: 'Failed to update webhook' },
      { status: 500 }
    )
  }
}
