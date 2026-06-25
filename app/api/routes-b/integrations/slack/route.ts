import { withRequestId } from '../../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

async function POSTHandler(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  let body: { webhookUrl?: unknown; channel?: unknown; events?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { webhookUrl, channel, events } = body
  if (typeof webhookUrl !== 'string' || !webhookUrl.startsWith('https://')) {
    return NextResponse.json(
      { error: 'webhookUrl must be a valid HTTPS URL' },
      { status: 422 },
    )
  }
  if (typeof channel !== 'string' || !channel.trim()) {
    return NextResponse.json({ error: 'channel is required' }, { status: 422 })
  }

  const integration = await prisma.integration.upsert({
    where: { userId_type: { userId: user.id, type: 'slack' } },
    create: {
      userId: user.id,
      type: 'slack',
      config: { webhookUrl, channel, events: Array.isArray(events) ? events : ['invoice.paid'] },
      enabled: true,
    },
    update: {
      config: { webhookUrl, channel, events: Array.isArray(events) ? events : ['invoice.paid'] },
      enabled: true,
    },
    select: { id: true, type: true, enabled: true, updatedAt: true },
  })

  logger.info({ userId: user.id, integrationId: integration.id }, 'Slack integration configured')

  return NextResponse.json({ integration })
}

export const POST = withRequestId(POSTHandler)
