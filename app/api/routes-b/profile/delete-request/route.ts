import { NextRequest, NextResponse } from 'next/server'
import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import {
  requestAccountDeletion,
  isAccountPendingDeletion,
  getDeletionWindowEnd,
} from '../../_lib/account-state'

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    // If already pending, return the existing window end instead of creating a new request
    if (isAccountPendingDeletion(user.id)) {
      const deletesAt = getDeletionWindowEnd(user.id)
      return NextResponse.json(
        { message: 'Account deletion already requested', deletesAt: deletesAt?.toISOString() },
        { status: 200 },
      )
    }

    const { token, deletesAt } = requestAccountDeletion(user.id)

    await prisma.auditEvent.create({
      data: {
        userId: user.id,
        action: 'ACCOUNT_DELETION_REQUESTED',
        entityType: 'User',
        entityId: user.id,
        metadata: {
          requestedAt: new Date().toISOString(),
          deletesAt: deletesAt.toISOString(),
        },
      },
    })

    return NextResponse.json({
      message: 'Account deletion requested. You have 14 days to cancel.',
      confirmationToken: token,
      deletesAt: deletesAt.toISOString(),
    })
  } catch (error) {
    logger.error({ err: error }, 'Routes-B profile delete-request POST error')
    return NextResponse.json({ error: 'Failed to request account deletion' }, { status: 500 })
  }
}
