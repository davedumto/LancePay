import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { rateLimit } from '../../_lib/rate-limit'
import { registerRoute } from '../../../_lib/openapi'
import { z } from 'zod'

// Register OpenAPI documentation
registerRoute({
  method: 'POST',
  path: '/webhooks/{id}/reveal',
  summary: 'Reveal webhook secret',
  description: 'Reveal the full webhook secret (rate limited to 3 calls per hour).',
  responseSchema: z.object({
    signingSecret: z.string(),
  }),
  tags: ['webhooks']
})

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  // Apply rate limiting: 3 calls per hour per user
  const rateLimitResult = await rateLimit(`webhook-reveal:${user.id}`, 3, 60 * 60 * 1000) // 1 hour
  if (!rateLimitResult.allowed) {
    return NextResponse.json(
      { 
        error: 'Rate limit exceeded',
        resetTime: rateLimitResult.resetTime,
        limit: 3,
        windowMs: 60 * 60 * 1000
      }, 
      { status: 429 }
    )
  }

  const webhook = await prisma.userWebhook.findUnique({
    where: { id },
    select: { 
      id: true, 
      userId: true, 
      signingSecret: true 
    },
  })

  if (!webhook) {
    return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })
  }

  if (webhook.userId !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Create audit log entry for secret reveal
  await prisma.auditEvent.create({
    data: {
      userId: user.id,
      action: 'WEBHOOK_SECRET_REVEALED',
      entityType: 'UserWebhook',
      entityId: webhook.id,
      metadata: {
        webhookId: webhook.id,
        revealedAt: new Date().toISOString(),
      },
    },
  })

  return NextResponse.json({
    signingSecret: webhook.signingSecret,
  })
}
