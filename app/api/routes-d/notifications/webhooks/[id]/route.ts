import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAuthContext } from '@/app/api/routes-d/disputes/_shared'

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
    console.error('Webhook deletion error:', error)
    return NextResponse.json(
      { error: 'Failed to delete webhook' },
      { status: 500 }
    )
  }
}
