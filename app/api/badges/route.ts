import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { parseBadgeCriteria, type BadgeCriteria } from '@/lib/badges'
import { logger } from '@/lib/logger'

export function describeBadgeCriteria(
  parsed: BadgeCriteria | null,
  rawJson: unknown,
): string {
  if (parsed) {
    switch (parsed.type) {
      case 'revenue':
        return `Complete at least $${parsed.minRevenue.toLocaleString('en-US')} in paid invoice volume`
      case 'invoices':
        return `Complete at least ${parsed.minInvoices} paid invoice${parsed.minInvoices === 1 ? '' : 's'}`
      case 'zero_disputes':
        return `Complete at least ${parsed.minInvoices} paid invoices with at most ${parsed.maxDisputes} dispute${parsed.maxDisputes === 1 ? '' : 's'}`
      case 'completion_rate':
        return `Maintain at least a ${parsed.minCompletionRate}% completion rate across ${parsed.minInvoices}+ invoices`
    }
  }
  if (
    typeof rawJson === 'object' &&
    rawJson !== null &&
    typeof (rawJson as Record<string, unknown>).summary === 'string'
  ) {
    return String((rawJson as Record<string, unknown>).summary)
  }
  return 'Custom milestone or manual verification badge'
}

/**
 * GET /api/badges
 *
 * Lists available BadgeDefinition rows with their criteria metadata (`criteriaJson`,
 * parsed `criteria`, and human-readable `criteriaSummary`) so the frontend can explain
 * unearned badges to users.
 *
 * Query parameters:
 * - `unearnedOnly=true` (or `unearned=true`): filters to only badges the authenticated
 *   user does not yet hold. Requires a valid Bearer token (`401` if unauthenticated).
 * - `includeInactive=true`: includes inactive badge definitions (defaults to `isActive: true`).
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const unearnedRaw =
      searchParams.get('unearnedOnly') ?? searchParams.get('unearned')
    const includeInactiveRaw = searchParams.get('includeInactive')

    if (
      unearnedRaw !== null &&
      unearnedRaw !== 'true' &&
      unearnedRaw !== 'false'
    ) {
      return NextResponse.json(
        { error: 'unearnedOnly must be "true" or "false"' },
        { status: 400 },
      )
    }

    if (
      includeInactiveRaw !== null &&
      includeInactiveRaw !== 'true' &&
      includeInactiveRaw !== 'false'
    ) {
      return NextResponse.json(
        { error: 'includeInactive must be "true" or "false"' },
        { status: 400 },
      )
    }

    const unearnedOnly = unearnedRaw === 'true'
    const includeInactive = includeInactiveRaw === 'true'

    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    let authenticatedUserId: string | null = null

    if (authToken) {
      const claims = await verifyAuthToken(authToken)
      if (!claims) {
        return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
      }
      const user = await prisma.user.findUnique({
        where: { privyId: claims.userId },
        select: { id: true },
      })
      if (!user) {
        return NextResponse.json({ error: 'User not found' }, { status: 404 })
      }
      authenticatedUserId = user.id
    } else if (unearnedOnly) {
      return NextResponse.json(
        { error: 'Authentication required when filtering by unearnedOnly=true' },
        { status: 401 },
      )
    }

    const earnedMap = new Map<string, { issuedAt: Date; stellarTxHash: string | null }>()
    if (authenticatedUserId) {
      const userBadges = await prisma.userBadge.findMany({
        where: { userId: authenticatedUserId },
        select: {
          badgeId: true,
          issuedAt: true,
          stellarTxHash: true,
        },
      })
      for (const ub of userBadges) {
        earnedMap.set(ub.badgeId, {
          issuedAt: ub.issuedAt,
          stellarTxHash: ub.stellarTxHash,
        })
      }
    }

    const definitions = await prisma.badgeDefinition.findMany({
      where: {
        ...(includeInactive ? {} : { isActive: true }),
        ...(unearnedOnly && earnedMap.size > 0
          ? { id: { notIn: Array.from(earnedMap.keys()) } }
          : {}),
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        description: true,
        criteriaJson: true,
        imageUrl: true,
        stellarAssetCode: true,
        isActive: true,
        createdAt: true,
      },
    })

    const badges = definitions
      .filter((def) => !(unearnedOnly && earnedMap.has(def.id)))
      .map((def) => {
        const parsedCriteria = parseBadgeCriteria(def.criteriaJson)
        const earnedInfo = earnedMap.get(def.id)

        return {
          id: def.id,
          name: def.name,
          description: def.description,
          criteriaJson: def.criteriaJson,
          criteria: parsedCriteria,
          criteriaSummary: describeBadgeCriteria(parsedCriteria, def.criteriaJson),
          imageUrl: def.imageUrl,
          stellarAssetCode: def.stellarAssetCode,
          isActive: def.isActive,
          earned: Boolean(earnedInfo),
          issuedAt: earnedInfo ? earnedInfo.issuedAt.toISOString() : null,
          createdAt: def.createdAt.toISOString(),
        }
      })

    return NextResponse.json(
      {
        badges,
        total: badges.length,
        unearnedOnly,
      },
      { status: 200 },
    )
  } catch (error) {
    logger.error({ err: error }, 'GET /api/badges error')
    return NextResponse.json({ error: 'Failed to fetch badge definitions' }, { status: 500 })
  }
}
