import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { checkRateLimit } from '../../../_lib/rate-limit'
import { dispatchWebhookDelivery } from '../../../_lib/webhook-delivery'

const TEST_DELIVERY_LIMIT = 10
const TEST_DELIVERY_WINDOW_MS = 60 * 60 * 1000

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

  const webhook = await prisma.userWebhook.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      targetUrl: true,
      signingSecret: true,
      isActive: true,
    },
  })

  if (!webhook) {
    return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })
  }
  if (webhook.userId !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  if (!webhook.isActive) {
    return NextResponse.json({ error: 'Webhook is inactive' }, { status: 422 })
  }

  const limitResult = checkRateLimit(`routes-b:webhook-test:${webhook.id}`, {
    limit: TEST_DELIVERY_LIMIT,
    windowMs: TEST_DELIVERY_WINDOW_MS,
  })
  if (!limitResult.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded for test deliveries' },
      {
        status: 429,
        headers: { 'Retry-After': String(limitResult.retryAfter) },
      },
    )
  }

  const eventId = `test_${webhook.id.replace(/-/g, '').slice(0, 16)}`
  const payload = {
    id: eventId,
    type: 'webhook.test',
    createdAt: '2026-01-01T00:00:00.000Z',
    data: {
      webhookId: webhook.id,
      deterministic: true,
    },
  }

  const result = await dispatchWebhookDelivery(webhook, 'webhook.test', payload)
  return NextResponse.json({ outcome: result })
}

