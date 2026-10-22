import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { isAdmin, resolveBadgeActor } from '@/app/api/_lib/badge-auth'

// GET /api/admin/badges/revocations
//
// Lists UserBadgeRevocation rows for audit purposes.
// Includes `trigger` and `reason` so reviewers can distinguish automated
// revocations (system job) from manual admin action.
//
// Query params:
//   ?userId=<uuid>    — filter by the user whose badge was revoked
//   ?badgeId=<uuid>   — filter by the badge definition
//
// Authorization: admin role only (resolveBadgeActor + isAdmin check)

export async function GET(request: NextRequest) {
  try {
    const auth = await resolveBadgeActor(request)
    if ('response' in auth) return auth.response
    const { actor } = auth

    if (!isAdmin(actor)) {
      return NextResponse.json({ error: 'Forbidden: admin access required' }, { status: 403 })
    }

    const { searchParams } = new URL(request.url)
    const userId = searchParams.get('userId')?.trim() || undefined
    const badgeId = searchParams.get('badgeId')?.trim() || undefined

    const revocations = await prisma.userBadgeRevocation.findMany({
      where: {
        ...(userId ? { userId } : {}),
        ...(badgeId ? { badgeId } : {}),
      },
      orderBy: { revokedAt: 'desc' },
      select: {
        id: true,
        userBadgeId: true,
        userId: true,
        badgeId: true,
        stellarTxHash: true,
        issuedAt: true,
        trigger: true,
        reason: true,
        revokedById: true,
        revokedAt: true,
        user: {
          select: { id: true, email: true, name: true },
        },
        badge: {
          select: { id: true, name: true, stellarAssetCode: true },
        },
        revokedBy: {
          select: { id: true, email: true, name: true },
        },
      },
    })

    return NextResponse.json({ revocations })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/admin/badges/revocations error')
    return NextResponse.json({ error: 'Failed to fetch badge revocations' }, { status: 500 })
  }
}
