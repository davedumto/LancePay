import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import crypto from 'crypto'

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { id } = await params
    if (!id) {
      return NextResponse.json({ error: 'Webhook ID is required' }, { status: 400 })
    }

    const webhook = await prisma.userWebhook.findUnique({
      where: { id },
    })

    if (!webhook) {
      return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })
    }

    if (webhook.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const newSecret = crypto.randomBytes(32).toString('hex')

    const updated = await prisma.userWebhook.update({
      where: { id },
      data: { signingSecret: newSecret },
    })

    return NextResponse.json({
      id: updated.id,
      targetUrl: updated.targetUrl,
      description: updated.description,
      isActive: updated.isActive,
      subscribedEvents: updated.subscribedEvents,
      createdAt: updated.createdAt,
      signingSecret: newSecret,
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-d/webhooks/[id]/rotate-secret error')
    return NextResponse.json({ error: 'Failed to rotate webhook secret' }, { status: 500 })
  }
}
