import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { DELETION_STATUS, findDeletionBlockers } from '@/lib/account-deletion'
import { logger } from '@/lib/logger'

export async function GET(request: Request) {
  // CRON_SECRET authorization check
  const authHeader = request.headers.get('authorization')
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const now = new Date()

    // 1. Fetch eligible pending rows with scheduledAt at or before now
    const dueRequests = await prisma.accountDeletionRequest.findMany({
      where: {
        status: DELETION_STATUS.PENDING,
        scheduledAt: { lte: now },
      },
    })

    const results = {
      processed: 0,
      completed: 0,
      parked: 0,
      racedOrSkipped: 0,
    }

    for (const req of dueRequests) {
      results.processed++

      // 2. Conditional update: claim row with status = 'pending' and scheduledAt <= now()
      // moves to an in-progress state first
      const claim = await prisma.accountDeletionRequest.updateMany({
        where: {
          id: req.id,
          status: DELETION_STATUS.PENDING,
          scheduledAt: { lte: now },
        },
        data: {
          status: DELETION_STATUS.IN_PROGRESS,
        },
      })

      if (claim.count === 0) {
        // Raced with cancellation or another executor worker
        results.racedOrSkipped++
        continue
      }

      // 3. Re-check findDeletionBlockers before deleting
      const blockers = await findDeletionBlockers(prisma, req.userId)
      if (blockers.length > 0) {
        // Park blocked request with a reason
        const blockerReason = blockers.map((b) => `${b.type} (${b.count})`).join(', ')
        await prisma.accountDeletionRequest.update({
          where: { id: req.id },
          data: {
            status: DELETION_STATUS.BLOCKED,
            reason: req.reason
              ? `${req.reason} [Blocked: ${blockerReason}]`
              : `Blocked: ${blockerReason}`,
          },
        })
        logger.warn(
          { userId: req.userId, requestId: req.id, blockers },
          'Account deletion request parked due to active blockers'
        )
        results.parked++
        continue
      }

      // 4. No blockers: complete deletion
      await prisma.$transaction(async (tx) => {
        await tx.accountDeletionRequest.update({
          where: { id: req.id },
          data: {
            status: DELETION_STATUS.COMPLETED,
            completedAt: new Date(),
          },
        })

        // Deactivate user profile / revoke settings
        await tx.user.update({
          where: { id: req.userId },
          data: {
            publicVisibility: false,
            twoFactorEnabled: false,
            twoFactorSecret: null,
            phone: null,
            avatarUrl: null,
          },
        })
      })

      logger.info({ userId: req.userId, requestId: req.id }, 'Account deletion executed successfully')
      results.completed++
    }

    return NextResponse.json({
      success: true,
      timestamp: now.toISOString(),
      ...results,
    })
  } catch (error) {
    logger.error({ err: error }, 'Error executing account deletions cron')
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

export const POST = GET
