import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const sessionVersionCache = new Map<string, number>()

export function getMinimumSessionVersion(userId: string): number {
  return sessionVersionCache.get(userId) ?? 1
}

export function isAccessTokenSessionVersionValid(
  userId: string,
  tokenSessionVersion: number,
): boolean {
  const minVersion = getMinimumSessionVersion(userId)
  return tokenSessionVersion >= minVersion
}

export function resetSessionVersionCache(): void {
  sessionVersionCache.clear()
}

async function requireAdminActor(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: 'Unauthorized', status: 401 as const, admin: null }
  }
  const token = authHeader.slice(7).trim()
  if (!token) {
    return { error: 'Unauthorized', status: 401 as const, admin: null }
  }

  const claims = await verifyAuthToken(token)
  if (!claims) {
    return { error: 'Unauthorized', status: 401 as const, admin: null }
  }

  let adminId = claims.userId
  let adminEmail = (claims as { email?: string | null }).email ?? null
  let role = (claims as { role?: string | null }).role ?? null

  if (typeof prisma.user?.findUnique === 'function') {
    const dbUser =
      (await prisma.user.findUnique({
        where: { privyId: claims.userId },
        select: { id: true, email: true, role: true },
      })) ??
      (await prisma.user.findUnique({
        where: { id: claims.userId },
        select: { id: true, email: true, role: true },
      }))

    if (dbUser) {
      adminId = dbUser.id
      adminEmail = dbUser.email ?? adminEmail
      role = dbUser.role ?? role
    }
  }

  const normalizedRole = (role ?? '').toLowerCase()
  if (
    normalizedRole !== 'admin' &&
    normalizedRole !== 'super_admin' &&
    normalizedRole !== 'security_admin' &&
    normalizedRole !== 'security_lead'
  ) {
    return {
      error: 'Forbidden: Admin access required',
      status: 403 as const,
      admin: null,
    }
  }

  return {
    error: null,
    status: 200 as const,
    admin: { id: adminId, email: adminEmail, role: normalizedRole },
  }
}

/**
 * POST /api/admin/users/[id]/force-logout
 * Force-signs out all active sessions for a user in a single atomic transaction:
 * - Bumps the user's sessionVersion so existing access tokens fail validation on the next request.
 * - Revokes all active UserSession / RefreshToken rows and embedded wallet session tokens atomically.
 * - Records the forcing admin and mandatory reason in the security audit log.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  try {
    const auth = await requireAdminActor(req)
    if (auth.error || !auth.admin) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const resolvedParams = await Promise.resolve(context.params)
    const targetUserId = resolvedParams?.id?.trim() || ''
    if (!targetUserId) {
      return NextResponse.json(
        { error: 'Target user id is required' },
        { status: 400 },
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

    const reason =
      typeof body.reason === 'string' ? body.reason.trim() : ''
    if (!reason || reason.length < 5) {
      return NextResponse.json(
        {
          error:
            'A security reason (at least 5 characters) is required to force-logout a user',
          code: 'REASON_REQUIRED',
        },
        { status: 400 },
      )
    }

    const targetUser = (await prisma.user.findUnique({
      where: { id: targetUserId },
    })) as Record<string, any> | null

    if (!targetUser) {
      return NextResponse.json(
        { error: 'Target user not found', code: 'USER_NOT_FOUND' },
        { status: 404 },
      )
    }

    const previousSessionVersion = Number(
      targetUser.sessionVersion ?? getMinimumSessionVersion(targetUserId),
    )
    const nextSessionVersion = previousSessionVersion + 1
    const revokedAt = new Date()

    const runAtomicForceLogout = async (txClient: Record<string, any>) => {
      // 1. Bump user's sessionVersion
      await txClient.user?.update?.({
        where: { id: targetUserId },
        data: {
          sessionVersion: nextSessionVersion,
        },
      })

      // 2. Revoke all active UserSession rows
      const userSessionsRes = await txClient.userSession?.updateMany?.({
        where: { userId: targetUserId, revokedAt: null },
        data: { revokedAt },
      })

      // 3. Revoke all refresh tokens
      const refreshTokensRes = await txClient.refreshToken?.updateMany?.({
        where: { userId: targetUserId, revokedAt: null },
        data: { revokedAt, status: 'revoked' },
      })

      // 4. Revoke all embedded wallet session tokens & anchor sessions
      const embeddedWalletRes =
        await txClient.embeddedWalletSession?.updateMany?.({
          where: { userId: targetUserId, revokedAt: null },
          data: { revokedAt, status: 'revoked' },
        })

      const anchorSessionsRes = await txClient.anchorSession?.deleteMany?.({
        where: { userId: targetUserId },
      })

      // 5. Record forcing admin and reason in the security audit log
      const securityLog = await txClient.securityAuditLog?.create?.({
        data: {
          userId: targetUserId,
          actorAdminId: auth.admin!.id,
          actorAdminEmail: auth.admin!.email,
          action: 'user.force_logout',
          reason,
          previousSessionVersion,
          newSessionVersion: nextSessionVersion,
          revokedSessionsCount: Number(userSessionsRes?.count ?? 0),
          revokedRefreshTokensCount: Number(refreshTokensRes?.count ?? 0),
          revokedWalletSessionsCount:
            Number(embeddedWalletRes?.count ?? 0) +
            Number(anchorSessionsRes?.count ?? 0),
          createdAt: revokedAt,
        },
      })

      await txClient.auditLog?.create?.({
        data: {
          actorId: auth.admin!.id,
          actorEmail: auth.admin!.email,
          action: 'admin.user.force_logout',
          resourceType: 'User',
          resourceId: targetUserId,
          metadata: {
            targetUserId,
            reason,
            previousSessionVersion,
            newSessionVersion: nextSessionVersion,
            revokedSessionsCount: Number(userSessionsRes?.count ?? 0),
            revokedRefreshTokensCount: Number(refreshTokensRes?.count ?? 0),
            revokedWalletSessionsCount:
              Number(embeddedWalletRes?.count ?? 0) +
              Number(anchorSessionsRes?.count ?? 0),
          },
        },
      })

      return {
        revokedUserSessions: Number(userSessionsRes?.count ?? 0),
        revokedRefreshTokens: Number(refreshTokensRes?.count ?? 0),
        revokedEmbeddedWalletSessions: Number(embeddedWalletRes?.count ?? 0),
        revokedAnchorSessions: Number(anchorSessionsRes?.count ?? 0),
        securityAuditId: securityLog?.id ?? null,
      }
    }

    const dbWithTx = prisma as unknown as {
      $transaction?: <T>(
        fn: (tx: Record<string, any>) => Promise<T>,
      ) => Promise<T>
    } & Record<string, any>

    const txResult =
      typeof dbWithTx.$transaction === 'function'
        ? await dbWithTx.$transaction((tx) => runAtomicForceLogout(tx))
        : await runAtomicForceLogout(dbWithTx)

    // Update in-memory edge sessionVersion cache only after atomic transaction commits
    sessionVersionCache.set(targetUserId, nextSessionVersion)

    logger?.warn?.(
      {
        targetUserId,
        forcingAdminId: auth.admin.id,
        previousSessionVersion,
        newSessionVersion: nextSessionVersion,
        reason,
      },
      'POST /api/admin/users/[id]/force-logout revoked all sessions and bumped sessionVersion',
    )

    return NextResponse.json({
      userId: targetUserId,
      forceLoggedOut: true,
      previousSessionVersion,
      sessionVersion: nextSessionVersion,
      revoked: {
        userSessions: txResult.revokedUserSessions,
        refreshTokens: txResult.revokedRefreshTokens,
        embeddedWalletSessions: txResult.revokedEmbeddedWalletSessions,
        anchorSessions: txResult.revokedAnchorSessions,
      },
      audit: {
        id: txResult.securityAuditId,
        forcedByAdminId: auth.admin.id,
        forcedByEmail: auth.admin.email,
        reason,
        revokedAt: revokedAt.toISOString(),
      },
    })
  } catch (err) {
    logger?.error?.({ err }, 'POST /api/admin/users/[id]/force-logout error')
    return NextResponse.json(
      { error: 'Failed to force-logout user sessions' },
      { status: 500 },
    )
  }
}
