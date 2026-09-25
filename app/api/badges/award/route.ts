import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { loadBadgeSignals, meetsBadgeCriteria, parseBadgeCriteria } from '@/lib/badges'
import { isAdmin, resolveBadgeActor } from '@/app/api/_lib/badge-auth'

// POST /api/badges/award
//
// Evaluates every active BadgeDefinition against the target user's own
// invoice, payment and dispute records and records a UserBadge for each newly
// earned one. Eligibility is computed here only; the body carries nothing but
// an optional target.
//
// Who may call it:
//   - any signed-in user, for themselves (body `userId` omitted or their own id)
//   - an admin, for any user
//   - a trusted system job (BADGE_SYSTEM_SECRET), for any user — `userId` required
//
// Idempotency: rows are inserted with ON CONFLICT DO NOTHING against the
// (userId, badgeId) unique constraint, and only rows this call actually
// inserted are returned. Concurrent or repeated calls can never duplicate a
// badge or report one twice.

const awardSchema = z.object({ userId: z.string().uuid().optional() })

export async function POST(request: NextRequest) {
  try {
    const auth = await resolveBadgeActor(request)
    if ('response' in auth) return auth.response
    const { actor } = auth

    let body: unknown = {}
    const raw = await request.text()
    if (raw.trim()) {
      try {
        body = JSON.parse(raw)
      } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
      }
    }

    const parsed = awardSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      )
    }

    const targetUserId = parsed.data.userId ?? (actor.kind === 'user' ? actor.id : undefined)
    if (!targetUserId) {
      return NextResponse.json({ error: 'userId is required for system requests' }, { status: 400 })
    }
    if (actor.kind === 'user' && targetUserId !== actor.id && !isAdmin(actor)) {
      return NextResponse.json({ error: 'Forbidden: admin access required to award other users' }, { status: 403 })
    }

    const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true } })
    if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const now = new Date()
    const [definitions, held, signals] = await Promise.all([
      prisma.badgeDefinition.findMany({ where: { isActive: true } }),
      prisma.userBadge.findMany({ where: { userId: target.id }, select: { badgeId: true } }),
      loadBadgeSignals(target.id, now),
    ])

    const heldIds = new Set(held.map((b) => b.badgeId))
    const earned = definitions.filter((definition) => {
      if (heldIds.has(definition.id)) return false
      const criteria = parseBadgeCriteria(definition.criteriaJson)
      return criteria !== null && meetsBadgeCriteria(criteria, signals)
    })

    if (earned.length === 0) return NextResponse.json({ userId: target.id, awarded: [] })

    const inserted = await prisma.userBadge.createManyAndReturn({
      data: earned.map((definition) => ({ userId: target.id, badgeId: definition.id, issuedAt: now })),
      skipDuplicates: true,
    })

    const byId = new Map(earned.map((definition) => [definition.id, definition]))
    const awarded = inserted.map((row) => {
      const definition = byId.get(row.badgeId)!
      return {
        id: row.id,
        badgeId: row.badgeId,
        name: definition.name,
        description: definition.description,
        imageUrl: definition.imageUrl,
        stellarAssetCode: definition.stellarAssetCode,
        issuedAt: row.issuedAt,
      }
    })

    return NextResponse.json({ userId: target.id, awarded }, { status: awarded.length > 0 ? 201 : 200 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/badges/award error')
    return NextResponse.json({ error: 'Failed to award badges' }, { status: 500 })
  }
}
