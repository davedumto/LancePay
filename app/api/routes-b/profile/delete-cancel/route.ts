import { NextRequest, NextResponse } from 'next/server'
import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import {
  cancelAccountDeletion,
  isAccountPendingDeletion,
} from '../../_lib/account-state'

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    if (!isAccountPendingDeletion(user.id)) {
      return NextResponse.json(
        { error: 'No active deletion request found or window has already closed' },
        { status: 409 },
      )
    }

    const cancelled = cancelAccountDeletion(user.id)
    if (!cancelled) {
      return NextResponse.json(
        { error: 'Could not cancel deletion request' },
        { status: 500 },
      )
    }

    await prisma.auditEvent.create({
      data: {
        userId: user.id,
        action: 'ACCOUNT_DELETION_CANCELLED',
        entityType: 'User',
        entityId: user.id,
        metadata: {
          cancelledAt: new Date().toISOString(),
        },
      },
    })

    return NextResponse.json({ message: 'Account deletion cancelled successfully.' })
  } catch (error) {
    logger.error({ err: error }, 'Routes-B profile delete-cancel POST error')
    return NextResponse.json({ error: 'Failed to cancel account deletion' }, { status: 500 })
  }
}
