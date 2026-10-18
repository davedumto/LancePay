import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

type RouteContext = {
  params:
    | Promise<{ id: string; sessionId: string }>
    | { id: string; sessionId: string }
}

// Immediate runtime revocation & active cache eviction registry so in-flight portal requests
// are rejected immediately upon revocation without waiting for any stale cache window.
const activePortalSessionCache = new Map<
  string,
  { sessionId: string; hashedToken: string; expiresAt: number | null }
>()
const revokedPortalSessionIds = new Set<string>()
const revokedPortalTokenHashes = new Set<string>()

export function seedClientPortalSessionCache(params: {
  sessionId: string
  hashedToken: string
  expiresAt?: Date | string | null
}): void {
  const expMs = params.expiresAt ? new Date(params.expiresAt).getTime() : null
  activePortalSessionCache.set(params.sessionId, {
    sessionId: params.sessionId,
    hashedToken: params.hashedToken,
    expiresAt: expMs,
  })
}

export function invalidateClientPortalSessionImmediately(params: {
  sessionId: string
  hashedToken?: string | null
}): void {
  activePortalSessionCache.delete(params.sessionId)
  revokedPortalSessionIds.add(params.sessionId)
  if (params.hashedToken) {
    revokedPortalTokenHashes.add(params.hashedToken)
  }
}

export function isClientPortalSessionActive(params: {
  sessionId?: string | null
  hashedToken?: string | null
}): boolean {
  if (params.sessionId && revokedPortalSessionIds.has(params.sessionId)) {
    return false
  }
  if (params.hashedToken && revokedPortalTokenHashes.has(params.hashedToken)) {
    return false
  }
  if (params.sessionId && activePortalSessionCache.has(params.sessionId)) {
    const cached = activePortalSessionCache.get(params.sessionId)!
    if (cached.expiresAt !== null && cached.expiresAt <= Date.now()) {
      activePortalSessionCache.delete(params.sessionId)
      return false
    }
    return true
  }
  return true
}

export function resetClientPortalSessionRuntimeState(): void {
  activePortalSessionCache.clear()
  revokedPortalSessionIds.clear()
  revokedPortalTokenHashes.clear()
}

async function resolveRouteParams(context?: RouteContext) {
  if (!context?.params) return { clientId: '', sessionId: '' }
  const resolved = await Promise.resolve(context.params)
  return {
    clientId: (resolved?.id ?? '').trim(),
    sessionId: (resolved?.sessionId ?? '').trim(),
  }
}

async function resolveAuthenticatedUser(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: 'Unauthorized', status: 401 as const, user: null }
  }
  const token = authHeader.slice(7).trim()
  if (!token) {
    return { error: 'Unauthorized', status: 401 as const, user: null }
  }

  const claims = await verifyAuthToken(token)
  if (!claims) {
    return { error: 'Unauthorized', status: 401 as const, user: null }
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
      return { error: 'User not found', status: 404 as const, user: null }
    }
    userId = dbUser.id
  }

  return { error: null, status: 200 as const, user: { id: userId } }
}

/**
 * POST /api/clients/[id]/portal-sessions/[sessionId]/revoke
 * Revokes a client's portal session (`ClientPortalSession`):
 * - Only the session owner (`session.userId === auth.user.id`) may revoke their own client's portal session.
 * - Rejects revoking a session that is already revoked or expired, returning a clear already-inactive state (`409`).
 * - Sets `revokedAt` and immediately invalidates the runtime session cache so any in-flight request is rejected immediately.
 */
export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const auth = await resolveAuthenticatedUser(req)
    if (auth.error || !auth.user) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const { clientId, sessionId } = await resolveRouteParams(context)
    if (!clientId || !sessionId) {
      return NextResponse.json(
        { error: 'Client ID and session ID are required' },
        { status: 400 },
      )
    }

    const session = await prisma.clientPortalSession.findUnique({
      where: { id: sessionId },
    })

    if (!session || session.clientId !== clientId) {
      return NextResponse.json(
        {
          error: 'Client portal session not found',
          code: 'PORTAL_SESSION_NOT_FOUND',
        },
        { status: 404 },
      )
    }

    // 1. Only the session owner may revoke their own client's portal session
    if (session.userId !== auth.user.id) {
      return NextResponse.json(
        {
          error:
            'Forbidden: only the session owner may revoke this client portal session',
          code: 'FORBIDDEN_NOT_SESSION_OWNER',
        },
        { status: 403 },
      )
    }

    // 2. Reject revoking a session that is already revoked or expired with a clear already-inactive state
    if (session.revokedAt) {
      invalidateClientPortalSessionImmediately({
        sessionId: session.id,
        hashedToken: session.hashedToken,
      })
      return NextResponse.json(
        {
          error: 'Client portal session is already revoked',
          code: 'PORTAL_SESSION_ALREADY_INACTIVE',
          alreadyInactive: true,
          inactiveReason: 'already_revoked',
          revokedAt: new Date(session.revokedAt).toISOString(),
        },
        { status: 409 },
      )
    }

    if (
      session.expiresAt &&
      new Date(session.expiresAt).getTime() <= Date.now()
    ) {
      invalidateClientPortalSessionImmediately({
        sessionId: session.id,
        hashedToken: session.hashedToken,
      })
      return NextResponse.json(
        {
          error: 'Client portal session has already expired',
          code: 'PORTAL_SESSION_ALREADY_INACTIVE',
          alreadyInactive: true,
          inactiveReason: 'already_expired',
          expiresAt: new Date(session.expiresAt).toISOString(),
        },
        { status: 409 },
      )
    }

    // 3. Set revokedAt and immediately evict/revoke in runtime cache so in-flight requests fail right away
    const revokedAt = new Date()
    invalidateClientPortalSessionImmediately({
      sessionId: session.id,
      hashedToken: session.hashedToken,
    })

    const updated = await prisma.clientPortalSession.update({
      where: { id: session.id },
      data: { revokedAt },
    })

    return NextResponse.json({
      revoked: true,
      session: {
        id: updated.id,
        userId: updated.userId,
        clientId: updated.clientId,
        tokenHint: updated.tokenHint,
        lastSeenAt: updated.lastSeenAt
          ? new Date(updated.lastSeenAt).toISOString()
          : null,
        revokedAt: new Date(updated.revokedAt ?? revokedAt).toISOString(),
        expiresAt: updated.expiresAt
          ? new Date(updated.expiresAt).toISOString()
          : null,
      },
    })
  } catch (err) {
    logger?.error?.(
      { err },
      'POST /api/clients/[id]/portal-sessions/[sessionId]/revoke error',
    )
    return NextResponse.json(
      { error: 'Failed to revoke client portal session' },
      { status: 500 },
    )
  }
}
