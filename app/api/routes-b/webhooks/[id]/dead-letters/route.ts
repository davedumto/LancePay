import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { deadLetterQueue } from '../../_lib/dead-letter'
import { registerRoute } from '../../../_lib/openapi'
import { z } from 'zod'

// Register OpenAPI documentation
registerRoute({
  method: 'GET',
  path: '/webhooks/{id}/dead-letters',
  summary: 'List dead-letter events',
  description: 'Get all dead-letter events for a specific webhook.',
  responseSchema: z.object({
    deadLetters: z.array(z.object({
      id: z.string(),
      eventType: z.string(),
      payload: z.string(),
      timestamp: z.string(),
      lastError: z.string().optional(),
      attemptCount: z.number(),
      lastStatusCode: z.number().optional(),
    }))
  }),
  tags: ['webhooks']
})

export async function GET(
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
    select: { id: true, userId: true },
  })

  if (!webhook) {
    return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })
  }

  if (webhook.userId !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const deadLetters = deadLetterQueue.list(id)

  return NextResponse.json({
    deadLetters: deadLetters.map(event => ({
      id: event.id,
      eventType: event.eventType,
      payload: event.payload,
      timestamp: event.timestamp.toISOString(),
      lastError: event.lastError,
      attemptCount: event.attemptCount,
      lastStatusCode: event.lastStatusCode,
    })),
  })
}
