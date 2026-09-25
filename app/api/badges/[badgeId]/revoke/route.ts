import { NextRequest, NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { isAdmin, resolveBadgeActor } from '@/app/api/_lib/badge-auth'

// DELETE /api/badges/[badgeId]/revoke
//
// `badgeId` is the BadgeDefinition id (UserBadge.badgeId). The holder is named
// in the body, and the UserBadge is looked up by the (userId, badgeId) unique
// pair, so one user's badge can never be revoked through another's.
//
// Body: { userId: uuid, reason: string (1–500 chars), trigger?: SystemTrigger }
//
// Authorization — ordinary users can never revoke badges:
//   - admin (User.role === "admin"): trigger is recorded as "admin"; a
//     `trigger` value in the body is rejected
//   - trusted system job (BADGE_SYSTEM_SECRET bearer credential): must send one
//     of the documented SYSTEM_TRIGGERS below
//
// The UserBadge row is deleted and a UserBadgeRevocation row capturing the
// badge snapshot, trigger, reason and admin actor is written in the same
// transaction. Deleting frees the (userId, badgeId) slot so the badge can be
// re-earned later. A user who does not currently hold the badge — never held
// it, or it was already revoked — gets 404; concurrent revocations of the same
// badge produce exactly one audit row and one 200.

const SYSTEM_TRIGGERS = [
  'dispute_lost', // a dispute on one of the user's invoices was resolved against them
  'criteria_no_longer_met', // periodic re-evaluation found the criteria violated
  'fraud_review', // account flagged by fraud / compliance review
] as const

const revokeSchema = z.object({
  userId: z.string().uuid(),
  reason: z.string().trim().min(1, 'reason is required').max(500),
  trigger: z.enum(SYSTEM_TRIGGERS).optional(),
})

type RouteContext = { params: Promise<{ badgeId: string }> }

function isNotFoundError(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2025'
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const auth = await resolveBadgeActor(request)
    if ('response' in auth) return auth.response
    const { actor } = auth

    if (actor.kind === 'user' && !isAdmin(actor)) {
      return NextResponse.json({ error: 'Forbidden: admin access required' }, { status: 403 })
    }

    const { badgeId } = await context.params
    if (!z.string().uuid().safeParse(badgeId).success) {
      return NextResponse.json({ error: 'Invalid badgeId' }, { status: 400 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = revokeSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      )
    }
    const { userId, reason, trigger } = parsed.data

    if (actor.kind === 'system' && !trigger) {
      return NextResponse.json(
        { error: `trigger is required for system revocations (one of: ${SYSTEM_TRIGGERS.join(', ')})` },
        { status: 400 },
      )
    }
    if (actor.kind === 'user' && trigger) {
      return NextResponse.json({ error: 'trigger is reserved for system revocations' }, { status: 400 })
    }

    let revocation
    try {
      revocation = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const removed = await tx.userBadge.delete({ where: { userId_badgeId: { userId, badgeId } } })
        return tx.userBadgeRevocation.create({
          data: {
            userBadgeId: removed.id,
            userId: removed.userId,
            badgeId: removed.badgeId,
            stellarTxHash: removed.stellarTxHash,
            issuedAt: removed.issuedAt,
            trigger: actor.kind === 'system' ? trigger! : 'admin',
            reason,
            revokedById: actor.kind === 'user' ? actor.id : null,
          },
        })
      })
    } catch (error) {
      if (isNotFoundError(error)) {
        return NextResponse.json({ error: 'User does not hold this badge' }, { status: 404 })
      }
      throw error
    }

    return NextResponse.json({
      revoked: true,
      userId: revocation.userId,
      badgeId: revocation.badgeId,
      trigger: revocation.trigger,
      reason: revocation.reason,
      revokedAt: revocation.revokedAt,
    })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/badges/[badgeId]/revoke error')
    return NextResponse.json({ error: 'Failed to revoke badge' }, { status: 500 })
  }
}
