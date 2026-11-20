import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function PATCH(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })
    if (user.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden: admin access required' }, { status: 403 })
    }

    const body = await request.json().catch(() => ({}))
    const { webhookId, newTargetUrl } = body

    if (!webhookId || typeof webhookId !== 'string') {
      return NextResponse.json({ error: 'webhookId is required' }, { status: 400 })
    }
    if (!newTargetUrl || typeof newTargetUrl !== 'string') {
      return NextResponse.json({ error: 'newTargetUrl is required' }, { status: 400 })
    }

    let url: URL
    try {
      url = new URL(newTargetUrl)
    } catch {
      return NextResponse.json({ error: 'newTargetUrl must be a valid URL' }, { status: 400 })
    }

    if (!['http:', 'https:'].includes(url.protocol)) {
      return NextResponse.json({ error: 'newTargetUrl must use http or https' }, { status: 400 })
    }

    const webhook = await (prisma as any).userWebhook.findUnique({ where: { id: webhookId } })
    if (!webhook) {
      return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })
    }

    const previousUrl = webhook.targetUrl
    const updated = await (prisma as any).userWebhook.update({
      where: { id: webhookId },
      data: { targetUrl: newTargetUrl },
      select: { id: true, targetUrl: true, updatedAt: true },
    })

    logger.info({ adminId: user.id, webhookId, previousUrl, newTargetUrl }, 'Webhook sink rewritten')

    return NextResponse.json({
      webhook: updated,
      previousUrl,
      rewrittenBy: user.email,
      rewrittenAt: new Date().toISOString(),
    })
  } catch (error) {
    logger.error({ err: error }, 'PATCH /api/routes-d/admin/webhooks/sink-rewrite error')
    return NextResponse.json({ error: 'Failed to rewrite webhook sink URL' }, { status: 500 })
  }
}
