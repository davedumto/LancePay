import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { requireComplianceActor } from '@/app/api/_lib/compliance-auth'

// GET /api/admin/security-watchlist/removal-audit
//
// Lists SecurityWatchlistRemovalAudit rows for audit purposes.
// Both additionReason and removalReason are always present in the response
// since the audit trail is only meaningful with both sides.
//
// Query params:
//   ?value=<string>       — filter by the watchlisted value (exact match)
//   ?removedById=<uuid>   — filter by the actor who performed the removal
//
// Authorization: admin or compliance role (requireComplianceActor)

export async function GET(request: NextRequest) {
  try {
    const auth = await requireComplianceActor(request)
    if ('response' in auth) return auth.response

    const { searchParams } = new URL(request.url)
    const value = searchParams.get('value')?.trim() || undefined
    const removedById = searchParams.get('removedById')?.trim() || undefined

    const audits = await prisma.securityWatchlistRemovalAudit.findMany({
      where: {
        ...(value ? { value } : {}),
        ...(removedById ? { removedById } : {}),
      },
      orderBy: { removedAt: 'desc' },
      select: {
        id: true,
        watchlistId: true,
        type: true,
        value: true,
        additionReason: true,
        removalReason: true,
        removedById: true,
        removedAt: true,
        removedBy: {
          select: { id: true, email: true, name: true, role: true },
        },
      },
    })

    return NextResponse.json({ audits })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/admin/security-watchlist/removal-audit error')
    return NextResponse.json(
      { error: 'Failed to fetch security watchlist removal audit' },
      { status: 500 },
    )
  }
}
