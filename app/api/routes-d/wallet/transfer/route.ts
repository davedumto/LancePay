import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const ALLOWED_BUCKETS = ['savings', 'operating', 'reserve'] as const

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 401 })

    let body: { fromBucket?: unknown; toBucket?: unknown; amount?: unknown; currency?: unknown }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { fromBucket, toBucket, amount, currency } = body

    if (!ALLOWED_BUCKETS.includes(fromBucket as typeof ALLOWED_BUCKETS[number])) {
      return NextResponse.json(
        { error: `fromBucket must be one of: ${ALLOWED_BUCKETS.join(', ')}` },
        { status: 422 },
      )
    }
    if (!ALLOWED_BUCKETS.includes(toBucket as typeof ALLOWED_BUCKETS[number])) {
      return NextResponse.json(
        { error: `toBucket must be one of: ${ALLOWED_BUCKETS.join(', ')}` },
        { status: 422 },
      )
    }
    if (fromBucket === toBucket) {
      return NextResponse.json({ error: 'fromBucket and toBucket must differ' }, { status: 422 })
    }
    if (typeof amount !== 'number' || amount <= 0) {
      return NextResponse.json({ error: 'amount must be a positive number' }, { status: 422 })
    }
    if (typeof currency !== 'string' || !currency.trim()) {
      return NextResponse.json({ error: 'currency is required' }, { status: 422 })
    }

    const transfer = await prisma.transaction.create({
      data: {
        userId: user.id,
        type: 'internal_transfer',
        status: 'completed',
        amount,
        currency: currency.toUpperCase(),
        metadata: { fromBucket, toBucket },
      },
      select: { id: true, type: true, status: true, amount: true, currency: true, createdAt: true },
    })

    logger.info({ userId: user.id, transferId: transfer.id, fromBucket, toBucket, amount }, 'Wallet transfer completed')

    return NextResponse.json({ transfer: { ...transfer, amount: Number(transfer.amount) } }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /wallet/transfer error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
