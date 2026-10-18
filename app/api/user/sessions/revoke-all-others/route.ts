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

export function isSessionRevokedOnAuthPath(
  sessionId?: string | null,
  tokenHint?: string | null,
): boolean {
  if (sessionId && revokedSessionIds.has(sessionId)) return true
  if (tokenHint && revokedTokenHints.has(tokenHint)) return true
  return false
}

export function clearRevokedSessionsCache(): void {
  revokedSessionIds.clear()
  revokedTokenHints.clear()
}

export function deriveTokenHint(token: string): string {
  const clean = token.trim()
  return clean.length <= 12 ? clean : clean.slice(-12)
}

/**
 * Verifies the caller's Bearer token AND checks session revocation state on the
 * authentication path so any session revoked via bulk or single revoke is immediately rejected.
 */
export async function authenticateActiveSession(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return {
      error: 'Unauthorized',
      code: 'UNAUTHORIZED',
      status: 401 as const,
      user: null,
      token: null,
      claims: null,
    }
  }

  const token = authHeader.slice(7).trim()
  if (!token) {
    return {
      error: 'Unauthorized',
      code: 'UNAUTHORIZED',
      status: 401 as const,
      user: null,
      token: null,
      claims: null,
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
      token: null,
      claims: null,
    }
  }

  const claimSessionId =
    (typeof claims.sessionId === 'string' && claims.sessionId.trim()) ||
    (typeof claims.sid === 'string' && claims.sid.trim()) ||
    req.headers.get('x-session-id')?.trim() ||
    null
  const tokenHint = deriveTokenHint(token)

  if (isSessionRevokedOnAuthPath(claimSessionId, tokenHint)) {
    return {
      error: 'Session has been revoked',
      code: 'SESSION_REVOKED',
      status: 401 as const,
      user: null,
      token: null,
      claims: null,
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
        token: null,
        claims: null,
      }
    }
    userId = dbUser.id
  }

  return {
    error: null,
    code: null,
    status: 200 as const,
    user: { id: userId },
    token,
    tokenHint,
    claimSessionId,
    claims,
  }
}

/**
 * POST /api/user/sessions/revoke-all-others
 * Signs out every other active session belonging to the authenticated user:
 * - Reliably identifies the current session (by sessionId claim, X-Session-Id header,
 *   body currentSessionId, or tokenHint) so the caller is never accidentally signed out.
 * - Revokes all other active sessions (`revokedAt = now`) and returns `revokedCount`.
 * - Propagates revoked session IDs and tokenHints to the authentication path immediately.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await authenticateActiveSession(req)
    if (auth.error || !auth.user || !auth.token) {
      return NextResponse.json(
        { error: auth.error, code: auth.code },
        { status: auth.status },
      )
    }

    let body: Record<string, unknown> = {}
    try {
      const raw = await req.text()
      if (raw.trim()) {
        body = JSON.parse(raw) as Record<string, unknown>
      }
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const bodySessionId =
      typeof body.currentSessionId === 'string' && body.currentSessionId.trim()
        ? body.currentSessionId.trim()
        : null

    const candidateSessionId = auth.claimSessionId ?? bodySessionId

    const activeSessions = await prisma.userSession.findMany({
      where: {
        userId: auth.user.id,
        revokedAt: null,
      },
    })

    const currentSession = activeSessions.find((s) => {
      if (candidateSessionId && s.id === candidateSessionId) return true
      if (
        s.tokenHint &&
        (s.tokenHint === auth.tokenHint ||
          auth.token!.endsWith(s.tokenHint))
      ) {
        return true
      }
      return false
    })

    if (!currentSession) {
      return NextResponse.json(
        {
          error:
            'Could not reliably identify the current active session; aborting bulk revoke to avoid signing out the caller',
          code: 'CURRENT_SESSION_UNIDENTIFIED',
        },
        { status: 400 },
      )
    }

    const otherActiveSessions = activeSessions.filter(
      (s) => s.id !== currentSession.id,
    )
    const now = new Date()

    const updateRes = await prisma.userSession.updateMany({
      where: {
        userId: auth.user.id,
        revokedAt: null,
        id: { not: currentSession.id },
      },
      data: {
        revokedAt: now,
      },
    })

    const revokedCount = Number(
      updateRes?.count ?? otherActiveSessions.length,
    )

    for (const other of otherActiveSessions) {
      markSessionRevokedOnAuthPath(other.id, other.tokenHint)
    }

    logger?.info?.(
      {
        userId: auth.user.id,
        preservedSessionId: currentSession.id,
        revokedCount,
      },
      'POST /api/user/sessions/revoke-all-others revoked other active sessions',
    )

    return NextResponse.json({
      revokedCount,
      preservedSessionId: currentSession.id,
      revokedSessionIds: otherActiveSessions.map((s) => s.id),
      revokedAt: now.toISOString(),
    })
  } catch (err) {
    logger?.error?.({ err }, 'POST /api/user/sessions/revoke-all-others error')
    return NextResponse.json(
      { error: 'Failed to revoke other active sessions' },
      { status: 500 },
    )
  }
}
