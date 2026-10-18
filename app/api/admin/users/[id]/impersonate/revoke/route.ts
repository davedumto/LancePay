import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export interface EdgeRevocationEntry {
  jti: string
  sessionId: string
  targetUserId: string
  revokedByAdminId: string
  revokedAt: string
  expiresAt: string
}

const edgeRevocationMap = new Map<string, EdgeRevocationEntry>()

export const impersonationRevocationList = {
  add(entry: EdgeRevocationEntry): void {
    edgeRevocationMap.set(entry.jti, entry)
  },
  isRevoked(jti: string): boolean {
    return edgeRevocationMap.has(jti)
  },
  getEntry(jti: string): EdgeRevocationEntry | undefined {
    return edgeRevocationMap.get(jti)
  },
  clear(): void {
    edgeRevocationMap.clear()
  },
}

export function isImpersonationTokenRevoked(jti: string): boolean {
  return impersonationRevocationList.isRevoked(jti)
}

const SECURITY_LEAD_ROLES = new Set([
  'security_lead',
  'security_admin',
  'super_admin',
])

const ALLOWED_ADMIN_ROLES = new Set([
  'admin',
  'support_admin',
  'ops_admin',
  'security_lead',
  'security_admin',
  'super_admin',
])

async function resolveCaller(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: 'Unauthorized', status: 401 as const, caller: null }
  }
  const token = authHeader.slice(7).trim()
  if (!token) {
    return { error: 'Unauthorized', status: 401 as const, caller: null }
  }

  const claims = await verifyAuthToken(token)
  if (!claims) {
    return { error: 'Unauthorized', status: 401 as const, caller: null }
  }

  let callerId = claims.userId
  let callerEmail = (claims as { email?: string | null }).email ?? null
  let role = (claims as { role?: string | null }).role ?? ''

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
      callerId = dbUser.id
      callerEmail = dbUser.email ?? callerEmail
      role = dbUser.role ?? role
    }
  }

  const normalizedRole = role.trim().toLowerCase()
  if (!ALLOWED_ADMIN_ROLES.has(normalizedRole)) {
    return {
      error: 'Forbidden: Admin or security lead role required',
      status: 403 as const,
      caller: null,
    }
  }

  return {
    error: null,
    status: 200 as const,
    caller: {
      id: callerId,
      email: callerEmail,
      role: normalizedRole,
      isSecurityLead: SECURITY_LEAD_ROLES.has(normalizedRole),
    },
  }
}

/**
 * POST /api/admin/users/[id]/impersonate/revoke
 * Immediately revokes an active impersonation session before expiry:
 * - Permits ONLY the impersonating admin who started the session OR a security lead.
 * - Adds the token identifier (jti) to the edge revocation list so in-flight requests are rejected at the edge.
 * - Records the revocation timestamp and actor on the original impersonation ledger row.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  try {
    const auth = await resolveCaller(req)
    if (auth.error || !auth.caller) {
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

    const sessionId =
      typeof body.sessionId === 'string' && body.sessionId.trim()
        ? body.sessionId.trim()
        : null
    const tokenJti =
      (typeof body.jti === 'string' && body.jti.trim()) ||
      (typeof body.tokenId === 'string' && body.tokenId.trim()) ||
      null
    const reason =
      typeof body.reason === 'string' && body.reason.trim()
        ? body.reason.trim()
        : 'Manual impersonation session revocation'

    const db = prisma as unknown as {
      impersonationSession?: {
        findUnique?: (args: unknown) => Promise<Record<string, any> | null>
        findFirst?: (args: unknown) => Promise<Record<string, any> | null>
        update: (args: unknown) => Promise<Record<string, any>>
      }
      tokenRevocationList?: {
        create?: (args: unknown) => Promise<Record<string, any>>
      }
      auditLog?: {
        create?: (args: unknown) => Promise<Record<string, any>>
      }
    }

    let session: Record<string, any> | null = null
    if (sessionId && typeof db.impersonationSession?.findUnique === 'function') {
      session = await db.impersonationSession.findUnique({
        where: { id: sessionId },
      })
    } else if (typeof db.impersonationSession?.findFirst === 'function') {
      session = await db.impersonationSession.findFirst({
        where: {
          targetUserId,
          ...(tokenJti ? { tokenJti } : {}),
          status: 'active',
        },
      })
    }

    if (!session || session.targetUserId !== targetUserId) {
      return NextResponse.json(
        {
          error: 'Active impersonation session not found for target user',
          code: 'IMPERSONATION_SESSION_NOT_FOUND',
        },
        { status: 404 },
      )
    }

    // Verify caller is either the impersonating admin OR a security lead
    const isInitiatingAdmin = auth.caller.id === session.impersonatorAdminId
    if (!isInitiatingAdmin && !auth.caller.isSecurityLead) {
      return NextResponse.json(
        {
          error:
            'Forbidden: Only the impersonating admin or a security lead can revoke this session',
          code: 'FORBIDDEN_NOT_IMPERSONATOR_OR_SECURITY_LEAD',
        },
        { status: 403 },
      )
    }

    if (session.revokedAt || session.status === 'revoked') {
      return NextResponse.json(
        {
          error: 'Impersonation session is already revoked',
          code: 'SESSION_ALREADY_REVOKED',
        },
        { status: 409 },
      )
    }

    const now = new Date()
    const expiresAtDate = session.expiresAt
      ? new Date(session.expiresAt)
      : new Date(now.getTime() + 60_000)

    if (expiresAtDate.getTime() <= now.getTime()) {
      return NextResponse.json(
        {
          error: 'Impersonation session has already expired',
          code: 'SESSION_ALREADY_EXPIRED',
        },
        { status: 409 },
      )
    }

    const effectiveJti = String(
      session.tokenJti ?? session.jti ?? tokenJti ?? `jti_${session.id}`,
    )

    // 1. Update original impersonation ledger row with revocation timestamp and actor
    const updatedLedgerRow = await db.impersonationSession!.update({
      where: { id: session.id },
      data: {
        status: 'revoked',
        revokedAt: now,
        revokedByAdminId: auth.caller.id,
        revokedByEmail: auth.caller.email,
        revokedByRole: auth.caller.role,
        revocationReason: reason,
      },
    })

    // 2. Add token identifier to edge revocation list so in-flight requests are rejected at the edge
    const revocationEntry: EdgeRevocationEntry = {
      jti: effectiveJti,
      sessionId: String(session.id),
      targetUserId,
      revokedByAdminId: auth.caller.id,
      revokedAt: now.toISOString(),
      expiresAt: expiresAtDate.toISOString(),
    }
    impersonationRevocationList.add(revocationEntry)

    await db.tokenRevocationList?.create?.({
      data: {
        jti: effectiveJti,
        sessionId: String(session.id),
        targetUserId,
        revokedByAdminId: auth.caller.id,
        reason,
        revokedAt: now,
        expiresAt: expiresAtDate,
      },
    })

    await db.auditLog?.create?.({
      data: {
        actorId: auth.caller.id,
        actorEmail: auth.caller.email,
        action: 'admin.user.impersonate.revoke',
        resourceType: 'ImpersonationSession',
        resourceId: String(session.id),
        metadata: {
          sessionId: session.id,
          targetUserId,
          impersonatorAdminId: session.impersonatorAdminId,
          revokedByAdminId: auth.caller.id,
          revokedByRole: auth.caller.role,
          jti: effectiveJti,
          reason,
          revokedAt: now.toISOString(),
        },
      },
    })

    logger?.info?.(
      {
        sessionId: session.id,
        targetUserId,
        jti: effectiveJti,
        revokedByAdminId: auth.caller.id,
      },
      'POST /api/admin/users/[id]/impersonate/revoke revoked impersonation session',
    )

    return NextResponse.json({
      revoked: true,
      session: {
        ...updatedLedgerRow,
        id: session.id,
        targetUserId,
        impersonatorAdminId: session.impersonatorAdminId,
        tokenJti: effectiveJti,
        status: 'revoked',
        revokedAt: now.toISOString(),
        revokedByAdminId: auth.caller.id,
        revokedByEmail: auth.caller.email,
        revokedByRole: auth.caller.role,
        revocationReason: reason,
      },
      revocationEntry,
    })
  } catch (err) {
    logger?.error?.(
      { err },
      'POST /api/admin/users/[id]/impersonate/revoke error',
    )
    return NextResponse.json(
      { error: 'Failed to revoke impersonation session' },
      { status: 500 },
    )
  }
}
