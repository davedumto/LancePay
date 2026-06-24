import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

type RouteContext = {
  params: Promise<{ id: string }> | { id: string }
}

async function resolveParams(context: RouteContext): Promise<{ id: string }> {
  const raw = context.params as { id: string } | Promise<{ id: string }>
  if (raw && typeof (raw as Promise<{ id: string }>).then === 'function') {
    return raw as Promise<{ id: string }>
  }
  return raw as { id: string }
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { id } = await resolveParams(context)

    if (!id) return NextResponse.json({ error: 'Transaction ID is required' }, { status: 400 })

    const transaction = await prisma.transaction.findUnique({ where: { id } })

    if (!transaction) return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })

    if (transaction.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    return NextResponse.json({
      receipt: {
        id: transaction.id,
        type: transaction.type,
        status: transaction.status,
        amount: transaction.amount?.toString() ?? null,
        currency: transaction.currency,
        createdAt: transaction.createdAt,
        completedAt: transaction.completedAt ?? null,
        txHash: transaction.txHash ?? null,
        reference: id,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'transaction receipt error')
    return NextResponse.json({ error: 'Failed to fetch transaction receipt' }, { status: 500 })
  }
}
