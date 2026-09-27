import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const APPROVABLE_STATUSES = ['pending', 'queued']

export async function POST(
  request: NextRequest,
  { params }: any
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const {} = await params
    if (!id || id.trim() === '') {
      return NextResponse.json({ error: 'Withdrawal ID is required' }, { status: 400 })
    }

    const withdrawal = await prisma.withdrawalTransaction.findFirst({
      where: { id, userId: user.id },
    })

    if (!withdrawal) {
      return NextResponse.json({ error: 'Withdrawal not found' }, { status: 404 })
    }

    if (withdrawal.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    if (!APPROVABLE_STATUSES.includes(withdrawal.status)) {
      return NextResponse.json(
        { error: `Withdrawal in status '${withdrawal.status}' cannot be approved` },
        { status: 409 }
      )
    }

    const updated = await prisma.withdrawalTransaction.update({
      where: { id },
      data: { status: 'submitted', updatedAt: new Date() },
    })

    return NextResponse.json({
      withdrawal: {
        id: updated.id,
        status: updated.status,
        amount: updated.amount,
        asset: updated.asset,
        anchorId: updated.anchorId,
        updatedAt: updated.updatedAt,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-d/withdrawals/[id]/approve error')
    return NextResponse.json({ error: 'Failed to approve withdrawal' }, { status: 500 })
  }
}
