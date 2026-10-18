import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const revokedSessionIds = new Set<string>()
const revokedTokenHints = new Set<string>()

export function markSessionRevokedOnAuthPath(
  sessionId: string,
  tokenHint?: string | null,
): void {
  revokedSessionIds.add(sessionId)
  if (tokenHint) {
    revokedTokenHints.add(tokenHint)
  }
}

export function clearRevokedSessionAuthCache(): void {
  revokedSessionIds.clear()
  revokedTokenHints.clear()
}

export function deriveTokenHint(token: string): string {
  const clean = token.trim()
  return clean.length <= 12 ? clean : clean.slice(-12)
}

/**
 * Authenticates a request on the user session authentication path, checking both
 * the in-memory revocation cache and the database UserSession row (`revokedAt !== null`)
 * so a revoked session can never authenticate subsequent requests.
 */
export async function authenticateSessionOnAuthPath(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return {
      error: 'Unauthorized',
      code: 'UNAUTHORIZED',
      status: 401 as const,
      user: null,
    }
  }

  const token = authHeader.slice(7).trim()
  if (!token) {
    return {
      error: 'Unauthorized',
      code: 'UNAUTHORIZED',
      status: 401 as const,
      user: null,
    }
  }

  const claims = (await verifyAuthToken(token)) as Record<
    string,
    unknown
  > | null
  if (!claims || typeof claims.userId !== 'string') {
    return {
      error: 'Unauthorized',
      code: 'UNAUTHORIZED',
      status: 401 as const,
      user: null,
    }
  }

  const callerSessionId =
    (typeof claims.sessionId === 'string' && claims.sessionId.trim()) ||
    req.headers.get('x-session-id')?.trim() ||
    null
  const tokenHint = deriveTokenHint(token)

  if (
    (callerSessionId && revokedSessionIds.has(callerSessionId)) ||
    revokedTokenHints.has(tokenHint)
  ) {
    return {
      error: 'Session has been revoked',
      code: 'SESSION_REVOKED',
      status: 401 as const,
      user: null,
    }
  }

  if (callerSessionId && typeof prisma.userSession?.findUnique === 'function') {
    const callerSession = await prisma.userSession.findUnique({
      where: { id: callerSessionId },
    })
    if (callerSession?.revokedAt) {
      markSessionRevokedOnAuthPath(callerSession.id, callerSession.tokenHint)
      return {
        error: 'Session has been revoked',
        code: 'SESSION_REVOKED',
        status: 401 as const,
        user: null,
      }
    }
  }

  let userId = claims.userId
  if (typeof prisma.user?.findUnique === 'function') {
    const dbUser =
      (await prisma.user.findUnique({
        where: { privyId: claims.userId },
        select: { id: true, email: true },
      })) ??
      (await prisma.user.findUnique({
        where: { id: claims.userId },
        select: { id: true, email: true },
      }))

    if (!dbUser) {
      return {
        error: 'User not found',
        code: 'USER_NOT_FOUND',
        status: 404 as const,
        user: null,
      }
    }
    userId = dbUser.id
  }

  return {
    error: null,
    code: null,
    status: 200 as const,
    user: { id: userId },
  }
}

/**
 * POST /api/user/sessions/[id]/revoke
 * Revokes a specific active session owned by the authenticated user:
 * - Enforces owner-only access (`403 FORBIDDEN_NOT_SESSION_OWNER`).
 * - Rejects revoking a session that is already revoked with `409 SESSION_ALREADY_REVOKED`.
 * - Enforces session revocation on the authentication path so a revoked session cannot
 *   still authenticate subsequent requests.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  try {
    const auth = await authenticateSessionOnAuthPath(req)
    if (auth.error || !auth.user) {
      return NextResponse.json(
        { error: auth.error, code: auth.code },
        { status: auth.status },
      )
    }

    const resolvedParams = await Promise.resolve(context.params)
    const sessionId = resolvedParams?.id?.trim() || ''
    if (!sessionId) {
      return NextResponse.json(
        { error: 'Session id is required' },
        { status: 400 },
      )
    }

    const session = await prisma.userSession.findUnique({
      where: { id: sessionId },
    })

    if (!session) {
      return NextResponse.json(
        { error: 'Session not found', code: 'SESSION_NOT_FOUND' },
        { status: 404 },
      )
    }

    if (session.userId !== auth.user.id) {
      return NextResponse.json(
        {
          error: 'Forbidden: Only the session owner may revoke this session',
          code: 'FORBIDDEN_NOT_SESSION_OWNER',
        },
        { status: 403 },
      )
    }

    if (session.revokedAt !== null && session.revokedAt !== undefined) {
      return NextResponse.json(
        {
          error: 'Session is already revoked',
          code: 'SESSION_ALREADY_REVOKED',
          status: 'inactive',
          session: {
            id: session.id,
            status: 'revoked',
            isActive: false,
            revokedAt: new Date(session.revokedAt).toISOString(),
          },
        },
        { status: 409 },
      )
    }

    const now = new Date()
    const updated = await prisma.userSession.update({
      where: { id: sessionId },
      data: { revokedAt: now },
    })

    markSessionRevokedOnAuthPath(sessionId, session.tokenHint)

    logger?.info?.(
      { userId: auth.user.id, sessionId },
      'POST /api/user/sessions/[id]/revoke revoked session',
    )

    return NextResponse.json({
      revoked: true,
      session: {
        id: updated.id,
        userId: updated.userId,
        deviceLabel: updated.deviceLabel ?? null,
        tokenHint: updated.tokenHint ?? null,
        status: 'revoked',
        isActive: false,
        revokedAt: new Date(updated.revokedAt ?? now).toISOString(),
      },
    })
  } catch (err) {
    logger?.error?.({ err }, 'POST /api/user/sessions/[id]/revoke error')
    return NextResponse.json(
      { error: 'Failed to revoke session' },
      { status: 500 },
    )
  }
}
