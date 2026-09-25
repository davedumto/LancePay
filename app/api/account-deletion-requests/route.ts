import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { sendAccountDeletionScheduledEmail } from '@/lib/email'
import {
  ACCOUNT_DELETION_GRACE_DAYS,
  ACCOUNT_DELETION_GRACE_MS,
  DATA_EXPORT_NOTIFICATION_TYPE,
  DELETION_STATUS,
  type DeletionBlocker,
  deletionRequestSelect,
  findDeletionBlockers,
  serializeDeletionRequest,
} from '@/lib/account-deletion'

const createDeletionRequestSchema = z
  .object({
    reason: z.string().trim().max(500).optional(),
  })
  .strict()

type CreateOutcome =
  | { kind: 'blocked'; blockers: DeletionBlocker[] }
  | { kind: 'exists'; request: Parameters<typeof serializeDeletionRequest>[0] }
  | { kind: 'created'; request: Parameters<typeof serializeDeletionRequest>[0] }

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true, email: true, name: true },
  })
}

/**
 * GET /api/account-deletion-requests
 * Returns the caller's deletion request (one row per user), or null.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const deletionRequest = await prisma.accountDeletionRequest.findUnique({
      where: { userId: user.id },
      select: deletionRequestSelect,
    })

    return NextResponse.json({
      deletionRequest: deletionRequest ? serializeDeletionRequest(deletionRequest, new Date()) : null,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/account-deletion-requests error')
    return NextResponse.json({ error: 'Failed to fetch account deletion request' }, { status: 500 })
  }
}

/**
 * POST /api/account-deletion-requests
 * Schedules account deletion after a grace period, provided nothing is still
 * in flight (unpaid invoices, active disputes, pending payouts). The same
 * request offers the user a data export before the deletion executes.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    let body: unknown = {}
    const rawBody = await request.text()
    if (rawBody.trim()) {
      try {
        body = JSON.parse(rawBody)
      } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
      }
    }

    const parsed = createDeletionRequestSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      )
    }
    const reason = parsed.data.reason || null

    const now = new Date()
    const scheduledAt = new Date(now.getTime() + ACCOUNT_DELETION_GRACE_MS)

    const outcome = await prisma.$transaction(async (tx): Promise<CreateOutcome> => {
      const existing = await tx.accountDeletionRequest.findUnique({
        where: { userId: user.id },
        select: deletionRequestSelect,
      })
      if (existing && existing.status !== DELETION_STATUS.CANCELLED) {
        return { kind: 'exists', request: existing }
      }

      const blockers = await findDeletionBlockers(tx, user.id)
      if (blockers.length > 0) return { kind: 'blocked', blockers }

      let created
      if (existing) {
        // AccountDeletionRequest is unique per user, so a new request after a
        // cancellation re-opens the same row. The status guard makes a
        // concurrent re-open lose instead of double-scheduling.
        const reopened = await tx.accountDeletionRequest.updateMany({
          where: { id: existing.id, status: DELETION_STATUS.CANCELLED },
          data: {
            status: DELETION_STATUS.PENDING,
            reason,
            scheduledAt,
            cancelledAt: null,
            completedAt: null,
            createdAt: now,
          },
        })
        if (reopened.count === 0) {
          const current = await tx.accountDeletionRequest.findUniqueOrThrow({
            where: { userId: user.id },
            select: deletionRequestSelect,
          })
          return { kind: 'exists', request: current }
        }
        created = await tx.accountDeletionRequest.findUniqueOrThrow({
          where: { id: existing.id },
          select: deletionRequestSelect,
        })
      } else {
        created = await tx.accountDeletionRequest.create({
          data: { userId: user.id, reason, status: DELETION_STATUS.PENDING, scheduledAt },
          select: deletionRequestSelect,
        })
      }

      await tx.notification.create({
        data: {
          userId: user.id,
          type: DATA_EXPORT_NOTIFICATION_TYPE,
          title: 'Download your data before your account is deleted',
          message: `Your account is scheduled for deletion on ${scheduledAt.toISOString()}. You can export your invoices, transactions and other records until then, or cancel the deletion.`,
        },
      })

      return { kind: 'created', request: created }
    })

    if (outcome.kind === 'blocked') {
      return NextResponse.json(
        {
          error: 'Account cannot be deleted while activity is still in progress',
          blockers: outcome.blockers,
        },
        { status: 409 },
      )
    }

    if (outcome.kind === 'exists') {
      return NextResponse.json(
        {
          error: 'An account deletion request is already active',
          deletionRequest: serializeDeletionRequest(outcome.request, now),
        },
        { status: 409 },
      )
    }

    // Fire-and-forget — the in-app notification is the durable record of the offer.
    sendAccountDeletionScheduledEmail({
      to: user.email,
      name: user.name || 'there',
      scheduledAt: outcome.request.scheduledAt,
    }).catch((err) => logger.error({ err }, 'Account deletion data export email failed'))

    logger.info(
      { userId: user.id, deletionRequestId: outcome.request.id, scheduledAt },
      'Account deletion requested',
    )

    return NextResponse.json(
      {
        deletionRequest: serializeDeletionRequest(outcome.request, now),
        graceDays: ACCOUNT_DELETION_GRACE_DAYS,
        dataExport: {
          offered: true,
          availableUntil: outcome.request.scheduledAt,
        },
      },
      { status: 202 },
    )
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return NextResponse.json(
        { error: 'An account deletion request is already active' },
        { status: 409 },
      )
    }
    logger.error({ err: error }, 'POST /api/account-deletion-requests error')
    return NextResponse.json({ error: 'Failed to create account deletion request' }, { status: 500 })
  }
}
