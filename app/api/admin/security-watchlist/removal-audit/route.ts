import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

function isAuthorizedRole(role: string | null | undefined): boolean {
  const normalized = (role ?? '').trim().toLowerCase()
  return (
    normalized === 'admin' ||
    normalized === 'compliance' ||
    normalized === 'compliance_admin'
  )
}

async function resolveAdminOrComplianceActor(req: NextRequest) {
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

  if (!isAuthorizedRole(actor.role)) {
    return {
      error: 'Forbidden: admin or compliance role required',
      status: 403 as const,
      actor: null,
    }
  }

  return { error: null, status: 200 as const, actor }
}

/**
 * GET /api/admin/security-watchlist/removal-audit
 * Lists audit entries for removed security watchlist items:
 * - Supports filtering by `value` or by `removedById`.
 * - Ensures `additionReason` and `removalReason` are both always present in the response.
 * - Restricts access to `admin` or `compliance` roles.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await resolveAdminOrComplianceActor(req)
    if (auth.error || !auth.actor) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const { searchParams } = new URL(req.url)
    const valueFilter = searchParams.get('value')?.trim()
    const removedByIdFilter = searchParams.get('removedById')?.trim()
    const typeFilter = searchParams.get('type')?.trim()
    const watchlistIdFilter = searchParams.get('watchlistId')?.trim()

    const where: Record<string, unknown> = {}
    if (valueFilter) {
      where.value = valueFilter
    }
    if (removedByIdFilter) {
      where.removedById = removedByIdFilter
    }
    if (typeFilter) {
      where.type = typeFilter
    }
    if (watchlistIdFilter) {
      where.watchlistId = watchlistIdFilter
    }

    const rows = (await prisma.securityWatchlistRemovalAudit.findMany({
      where,
      orderBy: { removedAt: 'desc' },
    })) as Record<string, any>[]

    const entries = (rows ?? []).map((row) => {
      const additionReason =
        typeof row.additionReason === 'string' && row.additionReason.trim()
          ? row.additionReason.trim()
          : 'No addition reason recorded'
      const removalReason =
        typeof row.removalReason === 'string' && row.removalReason.trim()
          ? row.removalReason.trim()
          : 'No removal reason recorded'

      return {
        id: row.id,
        watchlistId: row.watchlistId,
        type: row.type,
        value: row.value,
        additionReason,
        removalReason,
        removedById: row.removedById,
        removedAt: row.removedAt ? new Date(row.removedAt).toISOString() : null,
      }
    })

    return NextResponse.json({
      entries,
      audits: entries,
      total: entries.length,
    })
  } catch (err) {
    logger?.error?.(
      { err },
      'GET /api/admin/security-watchlist/removal-audit error',
    )
    return NextResponse.json(
      { error: 'Failed to list security watchlist removal audit history' },
      { status: 500 },
    )
  }
}
