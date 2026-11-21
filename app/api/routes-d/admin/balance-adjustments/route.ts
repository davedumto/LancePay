import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { isAdmin } from '@/lib/authorization'

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const adminUser = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!adminUser) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    if (!isAdmin(adminUser)) {
      return NextResponse.json({ error: 'Forbidden: admin access required' }, { status: 403 })
    }

    const body = await request.json()
    const { targetUserId, amount, currency, reason } = body

    if (!targetUserId || typeof targetUserId !== 'string') {
      return NextResponse.json({ error: 'targetUserId is required' }, { status: 400 })
    }
    if (amount === undefined || typeof amount !== 'number' || amount === 0) {
      return NextResponse.json({ error: 'A non-zero numeric amount is required' }, { status: 400 })
    }
    if (!currency || typeof currency !== 'string') {
      return NextResponse.json({ error: 'currency is required' }, { status: 400 })
    }
    if (!reason || typeof reason !== 'string' || reason.trim() === '') {
      return NextResponse.json({ error: 'reason is required' }, { status: 400 })
    }

    const targetUser = await prisma.user.findUnique({ where: { id: targetUserId } })
    if (!targetUser) {
      return NextResponse.json({ error: 'Target user not found' }, { status: 404 })
    }

    const transaction = await prisma.transaction.create({
      data: {
        userId: targetUserId,
        type: amount > 0 ? 'deposit' : 'withdrawal',
        status: 'completed',
        amount: Math.abs(amount),
        currency,
        completedAt: new Date(),
      },
    })

    logger.info(
      { adminId: adminUser.id, targetUserId, amount, currency, reason, transactionId: transaction.id },
      'Balance adjustment applied',
    )

    return NextResponse.json({ transaction, reason }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-d/admin/balance-adjustments error')
    return NextResponse.json({ error: 'Failed to apply balance adjustment' }, { status: 500 })
  }
}
