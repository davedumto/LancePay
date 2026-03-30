import crypto from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const claims = await verifyAuthToken(authToken)
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const webhook = await prisma.userWebhook.findUnique({ where: { id } })
  if (!webhook) {
    return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })
  }

  if (webhook.userId !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const payload = {
    event: 'ping',
    timestamp: new Date().toISOString(),
    webhookId: id,
  }

  const signature = crypto
    .createHmac('sha256', webhook.signingSecret)
    .update(JSON.stringify(payload))
    .digest('hex')

  try {
    const response = await fetch(webhook.targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-LancePay-Signature': `sha256=${signature}`,
      },
      body: JSON.stringify(payload),
    })

    const success = response.status >= 200 && response.status < 300

    return NextResponse.json({
      success,
      statusCode: response.status,
      targetUrl: webhook.targetUrl,
    })
  } catch (error) {
    logger.error({ err: error }, 'Routes B webhook ping network error')
    return NextResponse.json({
      success: false,
      statusCode: 0,
      targetUrl: webhook.targetUrl,
    })
  }
}
