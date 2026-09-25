import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import {
  DELETION_STATUS,
  deletionRequestSelect,
  remainingGraceSeconds,
  serializeDeletionRequest,
} from '@/lib/account-deletion'

/**
 * DELETE /api/account-deletion-requests/[id]
 * Cancels the caller's pending deletion request while its grace period is
 * still running. The cancel is a conditional update on (status, scheduledAt),
 * so it cannot succeed once the request has left "pending" or become due.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { id } = await params
    if (!id || id.trim() === '') {
      return NextResponse.json({ error: 'Deletion request ID is required' }, { status: 400 })
    }

    const deletionRequest = await prisma.accountDeletionRequest.findFirst({
      where: { id, userId: user.id },
      select: deletionRequestSelect,
    })
    if (!deletionRequest) {
      return NextResponse.json({ error: 'Deletion request not found' }, { status: 404 })
    }

    const now = new Date()

    if (deletionRequest.status === DELETION_STATUS.CANCELLED) {
      return NextResponse.json(
        { error: 'Deletion request is already cancelled', status: deletionRequest.status },
        { status: 409 },
      )
    }
    if (deletionRequest.status !== DELETION_STATUS.PENDING) {
      return NextResponse.json(
        { error: 'Deletion processing has already begun', status: deletionRequest.status },
        { status: 409 },
      )
    }
    if (deletionRequest.scheduledAt.getTime() <= now.getTime()) {
      return NextResponse.json(
        { error: 'The grace period has elapsed and the deletion can no longer be cancelled' },
        { status: 409 },
      )
    }

    const result = await prisma.accountDeletionRequest.updateMany({
      where: {
        id,
        userId: user.id,
        status: DELETION_STATUS.PENDING,
        scheduledAt: { gt: now },
      },
      data: { status: DELETION_STATUS.CANCELLED, cancelledAt: now },
    })
    if (result.count === 0) {
      return NextResponse.json(
        { error: 'Deletion request changed state and can no longer be cancelled' },
        { status: 409 },
      )
    }

    logger.info({ userId: user.id, deletionRequestId: id }, 'Account deletion request cancelled')

    return NextResponse.json({
      deletionRequest: serializeDeletionRequest(
        { ...deletionRequest, status: DELETION_STATUS.CANCELLED, cancelledAt: now },
        now,
      ),
      remainingGraceSeconds: remainingGraceSeconds(deletionRequest.scheduledAt, now),
      graceEndsAt: deletionRequest.scheduledAt,
    })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/account-deletion-requests/[id] error')
    return NextResponse.json({ error: 'Failed to cancel account deletion request' }, { status: 500 })
  }
}
