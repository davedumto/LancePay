import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// ── GET /api/routes-d/withdrawals - list withdrawal history for current user ──

const VALID_STATUSES = ['pending', 'completed', 'failed'] as const

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status')
    const limitParam = Number(searchParams.get('limit') ?? 20)

    if (status && !VALID_STATUSES.includes(status as typeof VALID_STATUSES[number])) {
      return NextResponse.json({ error: 'Invalid status. Must be one of: pending, completed, failed' }, { status: 400 })
    }

    const limit = Math.max(1, Math.min(100, isNaN(limitParam) ? 20 : limitParam))

    const where: { userId: string; type: string; status?: string } = {
      userId: user.id,
      type: 'withdrawal',
    }
    if (status) {
      where.status = status
    }

    const transactions = await prisma.transaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        status: true,
        amount: true,
        currency: true,
        createdAt: true,
      },
    })

    const withdrawals = transactions.map((t) => ({
      id: t.id,
      status: t.status,
      amount: Number(t.amount),
      currency: t.currency,
      createdAt: t.createdAt,
    }))

    return NextResponse.json({ withdrawals })
  } catch (error) {
    logger.error({ err: error }, 'Withdrawals GET error')
    return NextResponse.json({ error: 'Failed to get withdrawals' }, { status: 500 })
  }
}
