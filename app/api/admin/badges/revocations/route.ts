import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

async function resolveAdminActor(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: 'Unauthorized', status: 401 as const, actor: null }
  }
  const token = authHeader.slice(7).trim()
  if (!token) {
    return { error: 'Unauthorized', status: 401 as const, actor: null }
  }

  const claims = await verifyAuthToken(token)
  if (!claims) {
    return { error: 'Unauthorized', status: 401 as const, actor: null }
  }

  const actor =
    (await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true, email: true, role: true },
    })) ??
    (await prisma.user.findUnique({
      where: { id: claims.userId },
      select: { id: true, email: true, role: true },
    }))

  if (!actor) {
    return { error: 'User not found', status: 404 as const, actor: null }
  }

  if ((actor.role ?? '').trim().toLowerCase() !== 'admin') {
    return {
      error: 'Forbidden: admin role required',
      status: 403 as const,
      actor: null,
    }
  }

  return { error: null, status: 200 as const, actor }
}

/**
 * GET /api/admin/badges/revocations
 * Lists badge revocation audit history (`UserBadgeRevocation`):
 * - Supports filtering by `userId` or `badgeId`.
 * - Includes `trigger` and `reason` so reviewers can distinguish automated revocations from manual admin action.
 * - Restricts access to an `admin` role.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await resolveAdminActor(req)
    if (auth.error || !auth.actor) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const { searchParams } = new URL(req.url)
    const userIdFilter = searchParams.get('userId')?.trim()
    const badgeIdFilter = searchParams.get('badgeId')?.trim()
    const triggerFilter = searchParams.get('trigger')?.trim()

    const where: Record<string, unknown> = {}
    if (userIdFilter) {
      where.userId = userIdFilter
    }
    if (badgeIdFilter) {
      where.badgeId = badgeIdFilter
    }
    if (triggerFilter) {
      where.trigger = triggerFilter
    }

    const rows = (await prisma.userBadgeRevocation.findMany({
      where,
      orderBy: { revokedAt: 'desc' },
    })) as Record<string, any>[]

    const revocations = (rows ?? []).map((row) => {
      const trigger =
        typeof row.trigger === 'string' && row.trigger.trim()
          ? row.trigger.trim()
          : 'admin'
      const reason =
        typeof row.reason === 'string' && row.reason.trim()
          ? row.reason.trim()
          : 'No revocation reason recorded'
      const isAutomated = trigger !== 'admin'

      return {
        id: row.id,
        userBadgeId: row.userBadgeId ?? null,
        userId: row.userId,
        badgeId: row.badgeId,
        stellarTxHash: row.stellarTxHash ?? null,
        issuedAt: row.issuedAt ? new Date(row.issuedAt).toISOString() : null,
        trigger,
        reason,
        isAutomated,
        revocationSource: isAutomated
          ? ('automated' as const)
          : ('manual_admin' as const),
        revokedById: row.revokedById ?? null,
        revokedAt: row.revokedAt ? new Date(row.revokedAt).toISOString() : null,
      }
    })

    return NextResponse.json({
      revocations,
      total: revocations.length,
    })
  } catch (err) {
    logger?.error?.({ err }, 'GET /api/admin/badges/revocations error')
    return NextResponse.json(
      { error: 'Failed to list badge revocations' },
      { status: 500 },
    )
  }
}
