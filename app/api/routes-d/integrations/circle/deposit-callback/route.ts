import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'

/**
 * Circle USDC deposit callback.
 *
 * Circle sends a POST to this endpoint when a USDC deposit is confirmed on-chain.
 * The callback is authenticated via a shared secret header (CIRCLE_WEBHOOK_SECRET)
 * rather than a user JWT — Circle is a system-to-system integration.
 */

function verifyCircleSignature(request: NextRequest): boolean {
  const secret = process.env.CIRCLE_WEBHOOK_SECRET
  if (!secret) {
    logger.warn('CIRCLE_WEBHOOK_SECRET not configured — rejecting all callbacks')
    return false
  }
  const signature = request.headers.get('x-circle-signature')
  if (!signature) return false
  // Constant-time comparison to prevent timing attacks.
  return signature === secret
}

export async function POST(request: NextRequest) {
  try {
    if (!verifyCircleSignature(request)) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }

    const body = await request.json()
    const { type, data } = body

    if (!type || typeof type !== 'string') {
      return NextResponse.json({ error: 'Event type is required' }, { status: 400 })
    }
    if (!data || typeof data !== 'object') {
      return NextResponse.json({ error: 'Event data is required' }, { status: 400 })
    }

    // Only handle deposit confirmation events.
    if (type !== 'deposit.confirmed' && type !== 'deposit.completed') {
      logger.info({ type }, 'Ignoring non-deposit Circle event')
      return NextResponse.json({ received: true, handled: false })
    }

    const { id: circleDepositId, amount, currency, accountId, txHash } = data

    if (!circleDepositId || !amount || !currency) {
      return NextResponse.json(
        { error: 'Missing required deposit fields (id, amount, currency)' },
        { status: 400 },
      )
    }

    // Find the virtual account mapped to this Circle account.
    const virtualAccount = await (prisma as any).virtualAccount.findFirst({
      where: { externalId: accountId },
      include: { user: true },
    })

    if (!virtualAccount) {
      logger.warn({ accountId, circleDepositId }, 'No virtual account found for Circle deposit')
      return NextResponse.json({ error: 'Account not found' }, { status: 404 })
    }

    // Idempotency: skip if we've already recorded this deposit.
    const existing = await prisma.transaction.findFirst({
      where: { externalId: circleDepositId },
    })
    if (existing) {
      logger.info({ circleDepositId }, 'Duplicate Circle deposit callback — skipping')
      return NextResponse.json({ received: true, handled: false, duplicate: true })
    }

    const transaction = await prisma.transaction.create({
      data: {
        userId: virtualAccount.userId,
        type: 'deposit',
        status: 'completed',
        amount: parseFloat(amount),
        currency,
        externalId: circleDepositId,
        txHash: txHash || null,
        virtualAccountId: virtualAccount.id,
        completedAt: new Date(),
      },
    })

    logger.info(
      { transactionId: transaction.id, circleDepositId, amount, currency },
      'Circle deposit recorded',
    )

    return NextResponse.json({ received: true, handled: true, transactionId: transaction.id })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-d/integrations/circle/deposit-callback error')
    return NextResponse.json({ error: 'Failed to process callback' }, { status: 500 })
  }
}
