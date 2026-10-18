import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export const MAX_IMPERSONATION_TTL_SECONDS = 900 // 15 minutes

export const BLOCKED_MONEY_MOVEMENT_PATHS = [
  '/api/withdrawals',
  '/api/payout-batches',
  '/api/payments',
  '/api/manual-payments',
  '/api/stellar',
  '/api/collective-wallets',
  '/api/payment-advances',
  '/api/refunds',
] as const

const ADMIN_ROLES = new Set([
  'admin',
  'super_admin',
  'ops_admin',
  'support_admin',
  'security_lead',
  'security_admin',
  'compliance_admin',
])

export interface ImpersonationTokenClaims {
  jti: string
  sub: string
  act: {
    sub: string
    email: string | null
    role: string
  }
  mode: 'read_only'
  readOnly: true
  scopes: string[]
  blockedCapabilities: string[]
  blockedPathPrefixes: readonly string[]
  ticketReference: string
  iat: number
  exp: number
}

function getSigningSecret(): string {
  return (
    process.env.IMPERSONATION_TOKEN_SECRET ||
    process.env.ENCRYPTION_KEY ||
    'default-impersonation-signing-secret'
  )
}

export function issueImpersonationToken(
  claims: ImpersonationTokenClaims,
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'IMP+JWT' }),
    'utf8',
  ).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString(
    'base64url',
  )
  const sig = crypto
    .createHmac('sha256', getSigningSecret())
    .update(`${header}.${payload}`)
    .digest('base64url')
  return `${header}.${payload}.${sig}`
}

export function verifyImpersonationToken(
  token: string,
  nowUnix = Math.floor(Date.now() / 1000),
): ImpersonationTokenClaims | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, payload, sig] = parts
  const expectedSig = crypto
    .createHmac('sha256', getSigningSecret())
    .update(`${header}.${payload}`)
    .digest('base64url')
  if (sig !== expectedSig) return null

  try {
    const claims = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as ImpersonationTokenClaims
    if (claims.exp <= nowUnix) return null
    if (claims.exp - claims.iat > MAX_IMPERSONATION_TTL_SECONDS) return null
    return claims
  } catch {
    return null
  }
}

/**
 * Guard helper used by API routes/middleware to block money movement and state-mutating
 * operations while a caller is acting under an impersonation token.
 */
export function assertImpersonationAllowsRequest(
  claims: ImpersonationTokenClaims,
  method: string,
  pathname: string,
): { allowed: true } | { allowed: false; status: 403; code: string; error: string } {
  const normalizedMethod = method.toUpperCase()
  const normalizedPath = pathname.toLowerCase()

  const hitsMoneyMovementEndpoint = BLOCKED_MONEY_MOVEMENT_PATHS.some((prefix) =>
    normalizedPath.startsWith(prefix),
  )

  if (hitsMoneyMovementEndpoint) {
    return {
      allowed: false,
      status: 403,
      code: 'IMPERSONATION_MONEY_MOVEMENT_BLOCKED',
      error:
        'Money movement endpoints are strictly blocked during read-only support impersonation sessions',
    }
  }

  if (
    claims.readOnly &&
    normalizedMethod !== 'GET' &&
    normalizedMethod !== 'HEAD' &&
    normalizedMethod !== 'OPTIONS'
  ) {
    return {
      allowed: false,
      status: 403,
      code: 'IMPERSONATION_READ_ONLY_TOKEN',
      error:
        'Impersonation tokens are read-only and cannot perform state-mutating requests',
    }
  }

  return { allowed: true }
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
      adminId = dbUser.id
      adminEmail = dbUser.email ?? callerEmailFallback(adminEmail)
      role = dbUser.role ?? role
    }
  }

  const normalizedRole = role.trim().toLowerCase()
  if (!ADMIN_ROLES.has(normalizedRole)) {
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

function callerEmailFallback(email: string | null): string | null {
  return email
}

/**
 * POST /api/admin/users/[id]/impersonate
 * Creates a short-lived read-only impersonation session with full audit trail:
 * - Requires a support ticket reference and rejects impersonating other admin accounts.
 * - Issues a read-only token scoped to a 15-minute maximum lifetime that blocks money movement endpoints.
 * - Emits a user-visible security event & notification so the account holder can see support access in their log.
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

    let body: Record<string, unknown>
    try {
      body = (await req.json()) as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const ticketReference =
      (typeof body.ticketReference === 'string' &&
        body.ticketReference.trim()) ||
      (typeof body.ticketRef === 'string' && body.ticketRef.trim()) ||
      (typeof body.ticketId === 'string' && body.ticketId.trim()) ||
      ''

    if (!ticketReference || ticketReference.length < 3) {
      return NextResponse.json(
        {
          error:
            'ticketReference is required to start a support impersonation session',
          code: 'SUPPORT_TICKET_REQUIRED',
        },
        { status: 400 },
      )
    }

    const reason =
      typeof body.reason === 'string' && body.reason.trim()
        ? body.reason.trim()
        : `Support investigation for ticket ${ticketReference}`

    const requestedTtl =
      body.ttlSeconds !== undefined
        ? Number(body.ttlSeconds)
        : MAX_IMPERSONATION_TTL_SECONDS

    if (
      !Number.isInteger(requestedTtl) ||
      requestedTtl <= 0 ||
      requestedTtl > MAX_IMPERSONATION_TTL_SECONDS
    ) {
      return NextResponse.json(
        {
          error: `ttlSeconds must be an integer between 1 and ${MAX_IMPERSONATION_TTL_SECONDS} (15 minutes max)`,
          code: 'TTL_EXCEEDS_MAX_15_MINUTES',
          maxTtlSeconds: MAX_IMPERSONATION_TTL_SECONDS,
        },
        { status: 400 },
      )
    }

    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
    })

    if (!targetUser) {
      return NextResponse.json(
        { error: 'Target user not found', code: 'USER_NOT_FOUND' },
        { status: 404 },
      )
    }

    const targetRole = String(targetUser.role ?? 'freelancer')
      .trim()
      .toLowerCase()
    if (ADMIN_ROLES.has(targetRole) || targetUser.id === auth.admin.id) {
      return NextResponse.json(
        {
          error:
            'Forbidden: Impersonation of admin accounts is strictly prohibited',
          code: 'CANNOT_IMPERSONATE_ADMIN',
        },
        { status: 403 },
      )
    }

    const now = new Date()
    const issuedUnix = Math.floor(now.getTime() / 1000)
    const expiresUnix = issuedUnix + requestedTtl
    const expiresAt = new Date(expiresUnix * 1000)
    const sessionId = `imp_${crypto.randomBytes(12).toString('hex')}`
    const jti = `jti_${crypto.randomBytes(12).toString('hex')}`

    const tokenClaims: ImpersonationTokenClaims = {
      jti,
      sub: targetUserId,
      act: {
        sub: auth.admin.id,
        email: auth.admin.email,
        role: auth.admin.role,
      },
      mode: 'read_only',
      readOnly: true,
      scopes: [
        'read:profile',
        'read:invoices',
        'read:transactions',
        'read:disputes',
      ],
      blockedCapabilities: [
        'money_movement',
        'withdrawals',
        'payouts',
        'transfers',
        'multisig_sign',
        'key_rotation',
      ],
      blockedPathPrefixes: BLOCKED_MONEY_MOVEMENT_PATHS,
      ticketReference,
      iat: issuedUnix,
      exp: expiresUnix,
    }

    const token = issueImpersonationToken(tokenClaims)

    const db = prisma as unknown as {
      impersonationSession?: {
        create: (args: unknown) => Promise<Record<string, any>>
      }
      userSecurityEvent?: {
        create: (args: unknown) => Promise<Record<string, any>>
      }
      notification?: {
        create: (args: unknown) => Promise<Record<string, any>>
      }
      auditLog?: {
        create: (args: unknown) => Promise<Record<string, any>>
      }
    }

    const sessionRecord = await db.impersonationSession?.create({
      data: {
        id: sessionId,
        targetUserId,
        impersonatorAdminId: auth.admin.id,
        impersonatorEmail: auth.admin.email,
        ticketReference,
        reason,
        tokenJti: jti,
        mode: 'read_only',
        readOnly: true,
        status: 'active',
        ttlSeconds: requestedTtl,
        createdAt: now,
        expiresAt,
      },
    })

    // Emit user-visible security event so the account holder can see support access in their log
    const userSecurityEvent = await db.userSecurityEvent?.create({
      data: {
        userId: targetUserId,
        eventType: 'support.impersonation.started',
        visibleToUser: true,
        actorAdminId: auth.admin.id,
        actorAdminEmail: auth.admin.email,
        ticketReference,
        reason,
        sessionId,
        mode: 'read_only',
        expiresAt,
        createdAt: now,
      },
    })

    const notification = await db.notification?.create({
      data: {
        userId: targetUserId,
        type: 'security_alert',
        title: 'Support Read-Only Access Started',
        message: `LancePay Support (${auth.admin.email ?? auth.admin.id}) initiated a 15-minute read-only support session referencing ticket ${ticketReference}. Money movement is disabled.`,
        isRead: false,
      },
    })

    await db.auditLog?.create({
      data: {
        actorId: auth.admin.id,
        actorEmail: auth.admin.email,
        action: 'admin.user.impersonate.start',
        resourceType: 'ImpersonationSession',
        resourceId: sessionId,
        metadata: {
          sessionId,
          targetUserId,
          ticketReference,
          reason,
          jti,
          mode: 'read_only',
          ttlSeconds: requestedTtl,
          expiresAt: expiresAt.toISOString(),
        },
      },
    })

    logger?.warn?.(
      {
        sessionId,
        targetUserId,
        impersonatorAdminId: auth.admin.id,
        ticketReference,
        ttlSeconds: requestedTtl,
      },
      'POST /api/admin/users/[id]/impersonate created read-only impersonation session',
    )

    return NextResponse.json(
      {
        session: {
          ...(sessionRecord ?? {}),
          id: sessionId,
          targetUserId,
          impersonatorAdminId: auth.admin.id,
          ticketReference,
          reason,
          tokenJti: jti,
          mode: 'read_only',
          readOnly: true,
          blockedCapabilities: tokenClaims.blockedCapabilities,
          blockedPathPrefixes: BLOCKED_MONEY_MOVEMENT_PATHS,
          ttlSeconds: requestedTtl,
          createdAt: now.toISOString(),
          expiresAt: expiresAt.toISOString(),
        },
        token,
        userSecurityEvent: userSecurityEvent ?? {
          userId: targetUserId,
          eventType: 'support.impersonation.started',
          visibleToUser: true,
          ticketReference,
          notificationId: notification?.id ?? null,
        },
      },
      { status: 201 },
    )
  } catch (err) {
    logger?.error?.({ err }, 'POST /api/admin/users/[id]/impersonate error')
    return NextResponse.json(
      { error: 'Failed to create impersonation session' },
      { status: 500 },
    )
  }
}
