import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

function sanitizeTokenHint(rawHint: unknown): string | null {
  if (typeof rawHint !== 'string' || !rawHint.trim()) return null
  const trimmed = rawHint.trim()
  // Never expose more than the short 12-char hint
  return trimmed.length <= 12 ? trimmed : trimmed.slice(-12)
}

async function resolveAuthenticatedUser(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: 'Unauthorized', status: 401 as const, user: null, token: null }
  }
  const token = authHeader.slice(7).trim()
  if (!token) {
    return { error: 'Unauthorized', status: 401 as const, user: null, token: null }
  }

  const claims = await verifyAuthToken(token)
  if (!claims) {
    return { error: 'Unauthorized', status: 401 as const, user: null, token: null }
  }

  let userId = claims.userId
  if (typeof prisma.user?.findUnique === 'function') {
    const dbUser =
      (await prisma.user.findUnique({
        where: { privyId: claims.userId },
        select: { id: true },
      })) ??
      (await prisma.user.findUnique({
        where: { id: claims.userId },
        select: { id: true },
      }))

    if (!dbUser) {
      return { error: 'User not found', status: 404 as const, user: null, token: null }
    }
    userId = dbUser.id
  }

  const claimSessionId =
    (claims as { sessionId?: string | null }).sessionId ??
    req.headers.get('x-session-id') ??
    null
  const callerHint = sanitizeTokenHint(token)

  return {
    error: null,
    status: 200 as const,
    user: { id: userId },
    token,
    claimSessionId,
    callerHint,
  }
}

/**
 * GET /api/user/sessions
 * Lists active and recent login sessions for the authenticated user:
 * - Distinguishes currently-active sessions (`revokedAt === null`) from revoked ones (`revokedAt !== null`).
 * - Orders by `lastSeenAt` descending so the most recently active sessions appear first.
 * - Never exposes full session tokens, returning only the safe `tokenHint`.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await resolveAuthenticatedUser(req)
    if (auth.error || !auth.user) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const { searchParams } = new URL(req.url)
    const statusFilter = (searchParams.get('status') ?? 'all')
      .trim()
      .toLowerCase()

    if (
      statusFilter !== 'all' &&
      statusFilter !== 'active' &&
      statusFilter !== 'revoked'
    ) {
      return NextResponse.json(
        {
          error: 'status filter must be one of: all, active, revoked',
          code: 'INVALID_STATUS_FILTER',
        },
        { status: 400 },
      )
    }

    const where: Record<string, unknown> = {
      userId: auth.user.id,
    }
    if (statusFilter === 'active') {
      where.revokedAt = null
    } else if (statusFilter === 'revoked') {
      where.revokedAt = { not: null }
    }

    const rawSessions = (await prisma.userSession.findMany({
      where,
      orderBy: { lastSeenAt: 'desc' },
    })) as Record<string, any>[]

    // Ensure deterministic descending order by lastSeenAt even if mock returns unsorted rows
    const sorted = [...(rawSessions ?? [])].sort((a, b) => {
      const aTime = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0
      const bTime = b.lastSeenAt ? new Date(b.lastSeenAt).getTime() : 0
      return bTime - aTime
    })

    const sessions = sorted.map((s) => {
      const isRevoked = s.revokedAt !== null && s.revokedAt !== undefined
      const hint = sanitizeTokenHint(s.tokenHint)
      const isCurrent =
        !isRevoked &&
        Boolean(
          (auth.claimSessionId && s.id === auth.claimSessionId) ||
            (hint && auth.callerHint && hint === auth.callerHint),
        )

      return {
        id: s.id,
        userId: s.userId,
        deviceLabel: s.deviceLabel ?? null,
        userAgent: s.userAgent ?? null,
        ipAddress: s.ipAddress ?? null,
        tokenHint: hint,
        status: isRevoked ? ('revoked' as const) : ('active' as const),
        isActive: !isRevoked,
        isCurrent,
        issuedAt: s.issuedAt ? new Date(s.issuedAt).toISOString() : null,
        lastSeenAt: s.lastSeenAt ? new Date(s.lastSeenAt).toISOString() : null,
        revokedAt: isRevoked ? new Date(s.revokedAt).toISOString() : null,
      }
    })

    const activeSessions = sessions.filter((s) => s.isActive)
    const revokedSessions = sessions.filter((s) => !s.isActive)

    return NextResponse.json({
      sessions,
      activeSessions,
      revokedSessions,
      summary: {
        total: sessions.length,
        activeCount: activeSessions.length,
        revokedCount: revokedSessions.length,
      },
    })
  } catch (err) {
    logger?.error?.({ err }, 'GET /api/user/sessions error')
    return NextResponse.json(
      { error: 'Failed to list user sessions' },
      { status: 500 },
    )
  }
}
