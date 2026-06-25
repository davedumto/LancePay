import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 401 })

    let body: { amount?: unknown; currency?: unknown; destinationId?: unknown }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { amount, currency, destinationId } = body
    if (typeof amount !== 'number' || amount <= 0) {
      return NextResponse.json({ error: 'amount must be a positive number' }, { status: 422 })
    }
    if (typeof currency !== 'string' || !currency.trim()) {
      return NextResponse.json({ error: 'currency is required' }, { status: 422 })
    }
    if (typeof destinationId !== 'string' || !destinationId.trim()) {
      return NextResponse.json({ error: 'destinationId is required' }, { status: 422 })
    }

    const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
    if (!wallet) {
      return NextResponse.json({ error: 'Wallet not found' }, { status: 404 })
    }

    const payout = await prisma.transaction.create({
      data: {
        userId: user.id,
        type: 'instant_payout',
        status: 'pending',
        amount,
        currency: currency.toUpperCase(),
        metadata: { destinationId },
      },
      select: { id: true, type: true, status: true, amount: true, currency: true, createdAt: true },
    })

    logger.info({ userId: user.id, payoutId: payout.id, amount }, 'Instant payout requested')

    return NextResponse.json({ payout: { ...payout, amount: Number(payout.amount) } }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /payouts/instant error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
