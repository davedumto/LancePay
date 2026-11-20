import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// ── POST /api/routes-d/integrations/circle/payout-webhook — Circle payout webhook ──
//
// Accepts Circle payout event webhooks. Validates ownership and records the event.

interface CirclePayoutWebhookBody {
  payoutId?: string
  status?: string
  amount?: string
  currency?: string
  txHash?: string
  error?: string
  eventType?: string
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true, role: true },
  })
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const userWithRole = user as { id: string; role?: string }
    if (userWithRole.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden: admin access required' }, { status: 403 })
    }

    const body = (await request.json().catch(() => null)) as CirclePayoutWebhookBody | null
    if (!body || !body.payoutId || !body.status) {
      return NextResponse.json(
        { error: 'Invalid request: payoutId and status are required' },
        { status: 400 }
      )
    }

    const VALID_STATUSES = ['pending', 'processing', 'completed', 'failed', 'cancelled']
    const status = VALID_STATUSES.includes(body.status) ? body.status : 'pending'

    // Record or update Circle payout webhook event
    const webhookEvent = await (prisma as any).webhookEvent.upsert({
      where: {
        externalId: body.payoutId,
      },
      update: {
        status,
        txHash: body.txHash || null,
        error: body.error || null,
        processedAt: new Date(),
      },
      create: {
        externalId: body.payoutId,
        eventType: body.eventType || 'payout.status_changed',
        status,
        payload: {
          payoutId: body.payoutId,
          amount: body.amount,
          currency: body.currency,
          txHash: body.txHash,
          error: body.error,
        },
      },
    })

    logger.info({
      userId: user.id,
      payoutId: body.payoutId,
      status,
      eventId: webhookEvent.id,
    }, 'POST /api/routes-d/integrations/circle/payout-webhook')

    return NextResponse.json({
      success: true,
      eventId: webhookEvent.id,
      status: webhookEvent.status,
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-d/integrations/circle/payout-webhook error')
    return NextResponse.json(
      { error: 'Failed to process Circle payout webhook' },
      { status: 500 }
    )
  }
}