import { withRequestId } from '../../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { getWebhookHistory } from '../../../_lib/webhook-history'
import { registerRoute } from '../../../_lib/openapi'
import { z } from 'zod'

// Register OpenAPI documentation
registerRoute({
  method: 'GET',
  path: '/webhooks/{id}/history',
  summary: 'Get webhook delivery history',
  description: 'Returns the last 100 delivery attempts for a specific webhook (in-memory).',
  requestSchema: z.object({
    id: z.string().describe('Webhook ID'),
    status: z.enum(['ok', 'fail']).optional().describe('Filter by status')
  }),
  responseSchema: z.array(z.object({
    eventId: z.string(),
    ts: z.string(),
    status: z.string(),
    latencyMs: z.number(),
    attempt: z.number(),
    bodyExcerpt: z.string()
  })),
  tags: ['webhooks']
})

async function GETHandler(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { id } = params
    const webhook = await prisma.userWebhook.findUnique({
      where: { id, userId: user.id }
    })

    if (!webhook) {
      return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })
    }

    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status') as 'ok' | 'fail' | null
    
    if (status && status !== 'ok' && status !== 'fail') {
      return NextResponse.json({ error: 'Invalid status filter' }, { status: 400 })
    }

    const history = getWebhookHistory(id, status || undefined)

    return NextResponse.json(history)
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch webhook history' }, { status: 500 })
  }
}

export const GET = withRequestId(GETHandler)
