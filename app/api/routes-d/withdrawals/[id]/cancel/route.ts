import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// ── POST /api/routes-d/withdrawals/[id]/cancel — cancel a pending withdrawal ──
//
// Only the owner can cancel, and only while the underlying anchor flow is
// still in a cancellable state (`pending` or `interactive` per the existing
// schema). Once the withdrawal has been submitted to the network it is no
// longer ours to cancel.

const CANCELLABLE_STATUSES = ['pending', 'interactive'] as const

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { id } = await params
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

    const withdrawal = await prisma.withdrawalTransaction.findUnique({ where: { id } })
    if (!withdrawal) {
      return NextResponse.json({ error: 'Withdrawal not found' }, { status: 404 })
    }
    if (withdrawal.userId !== user.id) {
      return NextResponse.json(
        { error: 'Not authorized to cancel this withdrawal' },
        { status: 403 },
      )
    }
    if (!CANCELLABLE_STATUSES.includes(withdrawal.status as typeof CANCELLABLE_STATUSES[number])) {
      return NextResponse.json(
        {
          error: `Withdrawal cannot be cancelled in status '${withdrawal.status}'`,
          status: withdrawal.status,
        },
        { status: 409 },
      )
    }

    const updated = await prisma.withdrawalTransaction.update({
      where: { id },
      data: {
        status: 'cancelled',
        completedAt: new Date(),
      },
      select: {
        id: true,
        status: true,
        amount: true,
        asset: true,
        completedAt: true,
      },
    })

    return NextResponse.json({
      withdrawal: {
        ...updated,
        amount: Number(updated.amount),
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'Cancel withdrawal error')
    return NextResponse.json({ error: 'Failed to cancel withdrawal' }, { status: 500 })
  }
}
