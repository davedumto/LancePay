import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

async function resolveOptionalCaller(request: NextRequest) {
  const token = request.headers.get('authorization')?.replace('Bearer ', '').trim()
  if (!token) return null

  try {
    const claims = await verifyAuthToken(token)
    if (!claims?.userId) return null

    return await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true, role: true },
    })
  } catch {
    return null
  }
}

/**
 * GET /api/users/[id]/badges
 *
 * Lists the earned badges (`UserBadge` joined with `BadgeDefinition`) for the
 * specified user `id`.
 *
 * - Enforces the user's `publicVisibility` setting: when `publicVisibility === false`,
 *   only the user themselves or an admin may view their badges (`403 Forbidden`
 *   for anonymous or other users).
 * - Excludes any badge that has an active `UserBadgeRevocation` record so
 *   revoked badges are never surfaced as currently held.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params
    if (!id || typeof id !== 'string' || !id.trim()) {
      return NextResponse.json({ error: 'User id is required' }, { status: 400 })
    }

    const targetUser = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        publicVisibility: true,
      },
    })

    if (!targetUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Enforce public badge visibility opt-out
    if (targetUser.publicVisibility === false) {
      const caller = await resolveOptionalCaller(request)
      const isSelf = caller?.id === targetUser.id
      const isAdmin = caller?.role === 'admin'
      if (!isSelf && !isAdmin) {
        return NextResponse.json(
          { error: 'Forbidden: user has opted out of public badge visibility' },
          { status: 403 },
        )
      }
    }

    const [userBadges, revocations] = await Promise.all([
      prisma.userBadge.findMany({
        where: { userId: id },
        include: {
          badge: true,
        },
        orderBy: { issuedAt: 'desc' },
      }),
      prisma.userBadgeRevocation?.findMany
        ? prisma.userBadgeRevocation.findMany({
            where: { userId: id },
            select: {
              userBadgeId: true,
              badgeId: true,
              revokedAt: true,
            },
          })
        : Promise.resolve([]),
    ])

    const revokedUserBadgeIds = new Set(
      revocations.map((r) => r.userBadgeId).filter(Boolean),
    )
    const latestRevocationByBadgeId = new Map<string, Date>()
    for (const rev of revocations) {
      if (!rev.badgeId || !rev.revokedAt) continue
      const existing = latestRevocationByBadgeId.get(rev.badgeId)
      const revokedTime = new Date(rev.revokedAt)
      if (!existing || revokedTime > existing) {
        latestRevocationByBadgeId.set(rev.badgeId, revokedTime)
      }
    }

    const activeBadges = userBadges
      .filter((ub) => {
        if (revokedUserBadgeIds.has(ub.id)) return false
        const latestRevokedAt = latestRevocationByBadgeId.get(ub.badgeId)
        if (
          latestRevokedAt &&
          ub.issuedAt &&
          new Date(ub.issuedAt).getTime() <= latestRevokedAt.getTime()
        ) {
          return false
        }
        return true
      })
      .map((ub) => ({
        id: ub.id,
        userId: ub.userId,
        badgeId: ub.badgeId,
        name: ub.badge?.name ?? null,
        description: ub.badge?.description ?? null,
        imageUrl: ub.badge?.imageUrl ?? null,
        stellarAssetCode: ub.badge?.stellarAssetCode ?? null,
        criteriaJson: ub.badge?.criteriaJson ?? null,
        stellarTxHash: ub.stellarTxHash ?? null,
        issuedAt: ub.issuedAt,
        badge: ub.badge ?? null,
      }))

    return NextResponse.json(
      {
        userId: id,
        badges: activeBadges,
        count: activeBadges.length,
      },
      { status: 200 },
    )
  } catch (error) {
    logger.error({ err: error }, 'GET /api/users/[id]/badges error')
    return NextResponse.json(
      { error: 'Failed to fetch user badges' },
      { status: 500 },
    )
  }
}
