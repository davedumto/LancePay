import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export const ADMIN_SEARCH_RATE_LIMIT_MAX = 10
export const ADMIN_SEARCH_WINDOW_MS = 60_000

interface SeatRateBucket {
  count: number
  resetAtMs: number
}

const adminSeatBuckets = new Map<string, SeatRateBucket>()

export function resetAdminSearchRateLimiter(): void {
  adminSeatBuckets.clear()
}

function consumeSeatQuota(
  adminId: string,
  maxRequests = ADMIN_SEARCH_RATE_LIMIT_MAX,
  nowMs = Date.now(),
): {
  allowed: boolean
  remaining: number
  retryAfterSeconds: number
} {
  const existing = adminSeatBuckets.get(adminId)
  if (!existing || existing.resetAtMs <= nowMs) {
    const bucket: SeatRateBucket = {
      count: 1,
      resetAtMs: nowMs + ADMIN_SEARCH_WINDOW_MS,
    }
    adminSeatBuckets.set(adminId, bucket)
    return {
      allowed: true,
      remaining: Math.max(0, maxRequests - 1),
      retryAfterSeconds: Math.ceil(ADMIN_SEARCH_WINDOW_MS / 1000),
    }
  }

  if (existing.count >= maxRequests) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((existing.resetAtMs - nowMs) / 1000),
      ),
    }
  }

  existing.count += 1
  return {
    allowed: true,
    remaining: Math.max(0, maxRequests - existing.count),
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((existing.resetAtMs - nowMs) / 1000),
    ),
  }
}

const ADMIN_ROLES = new Set([
  'admin',
  'support_admin',
  'ops_admin',
  'compliance_admin',
  'compliance_unmask',
  'security_admin',
  'super_admin',
])

const UNMASK_ROLES = new Set([
  'compliance_unmask',
  'compliance_admin',
  'super_admin',
])

function hasComplianceUnmaskRole(
  role: string,
  claims: Record<string, unknown>,
): boolean {
  if (UNMASK_ROLES.has(role)) return true
  const roles = Array.isArray(claims.roles) ? claims.roles : []
  const perms = Array.isArray(claims.permissions) ? claims.permissions : []
  return (
    roles.some(
      (r) => typeof r === 'string' && UNMASK_ROLES.has(r.toLowerCase()),
    ) ||
    perms.some(
      (p) =>
        typeof p === 'string' &&
        (p.toLowerCase() === 'compliance:unmask' ||
          p.toLowerCase() === 'pii:unmask'),
    )
  )
}

async function authenticateAdmin(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: 'Unauthorized', status: 401 as const, admin: null }
  }
  const token = authHeader.slice(7).trim()
  if (!token) {
    return { error: 'Unauthorized', status: 401 as const, admin: null }
  }

  const claims = (await verifyAuthToken(token)) as Record<
    string,
    unknown
  > | null
  if (!claims || typeof claims.userId !== 'string') {
    return { error: 'Unauthorized', status: 401 as const, admin: null }
  }

  let adminId = claims.userId
  let adminEmail = typeof claims.email === 'string' ? claims.email : null
  let role = typeof claims.role === 'string' ? claims.role : ''

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
    admin: {
      id: adminId,
      email: adminEmail,
      role: normalizedRole,
      canUnmaskPii: hasComplianceUnmaskRole(normalizedRole, claims),
    },
  }
}

export function computeSearchHash(value: string): string {
  return crypto
    .createHash('sha256')
    .update(value.trim().toLowerCase())
    .digest('hex')
}

function redactEmail(email: string | null | undefined): string | null {
  if (!email || !email.includes('@')) return null
  const [local, domain] = email.split('@')
  if (!local || !domain) return '***'
  return `${local[0]}***@${domain}`
}

function redactPhone(phone: string | null | undefined): string | null {
  if (!phone) return null
  const digits = phone.replace(/\D/g, '')
  if (digits.length < 4) return '***'
  return `***-***-${digits.slice(-4)}`
}

function redactDisplayName(name: string | null | undefined): string | null {
  if (!name) return null
  return name
    .trim()
    .split(/\s+/)
    .map((part) => (part.length > 1 ? `${part[0]}***` : '*'))
    .join(' ')
}

/**
 * GET /api/admin/users/search
 * Full-text and indexed vector search across users matching on email, display name,
 * wallet address, and external reference:
 * - Rate-limits per admin seat to throttle bulk directory harvesting (429).
 * - Redacts PII fields unless the caller holds the compliance unmask role AND supplies
 *   an `X-Unmask-Reason` header.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await authenticateAdmin(req)
    if (auth.error || !auth.admin) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const quota = consumeSeatQuota(auth.admin.id)
    if (!quota.allowed) {
      return NextResponse.json(
        {
          error:
            'Rate limit exceeded for admin seat: bulk user directory harvesting is throttled',
          code: 'ADMIN_SEARCH_RATE_LIMITED',
          retryAfterSeconds: quota.retryAfterSeconds,
        },
        {
          status: 429,
          headers: {
            'Retry-After': String(quota.retryAfterSeconds),
            'X-RateLimit-Limit': String(ADMIN_SEARCH_RATE_LIMIT_MAX),
            'X-RateLimit-Remaining': '0',
          },
        },
      )
    }

    const { searchParams } = new URL(req.url)
    const query = (
      searchParams.get('q') ??
      searchParams.get('query') ??
      ''
    ).trim()

    if (!query || query.length < 2) {
      return NextResponse.json(
        {
          error: 'Search query parameter "q" must be at least 2 characters',
          code: 'INVALID_SEARCH_QUERY',
        },
        { status: 400 },
      )
    }

    const unmaskRequested =
      searchParams.get('unmask') === 'true' ||
      Boolean(req.headers.get('x-unmask-reason')) ||
      Boolean(req.headers.get('x-compliance-reason'))

    const unmaskReason = (
      req.headers.get('x-unmask-reason') ??
      req.headers.get('x-compliance-reason') ??
      ''
    ).trim()

    if (searchParams.get('unmask') === 'true' && !auth.admin.canUnmaskPii) {
      return NextResponse.json(
        {
          error:
            'Forbidden: Compliance unmask role is required to unmask PII fields',
          code: 'COMPLIANCE_UNMASK_ROLE_REQUIRED',
        },
        { status: 403 },
      )
    }

    if (
      searchParams.get('unmask') === 'true' &&
      auth.admin.canUnmaskPii &&
      unmaskReason.length < 5
    ) {
      return NextResponse.json(
        {
          error:
            'X-Unmask-Reason header (min 5 characters) is required when unmasking PII',
          code: 'UNMASK_REASON_HEADER_REQUIRED',
        },
        { status: 400 },
      )
    }

    const shouldUnmaskPii =
      unmaskRequested && auth.admin.canUnmaskPii && unmaskReason.length >= 5

    const limit = Math.min(
      50,
      Math.max(1, parseInt(searchParams.get('limit') ?? '20', 10) || 20),
    )

    const queryHash = computeSearchHash(query)
    const normalizedQuery = query.toLowerCase()

    // Query using indexed search vectors across email, name, wallet.address, and external references
    const candidates = (await prisma.user.findMany({
      where: {
        OR: [
          { email: { contains: query, mode: 'insensitive' } },
          { name: { contains: query, mode: 'insensitive' } },
          { privyId: { contains: query, mode: 'insensitive' } },
          { referralCode: { contains: query, mode: 'insensitive' } },
          {
            wallet: {
              is: { address: { contains: query, mode: 'insensitive' } },
            },
          },
          {
            virtualAccount: {
              is: { providerRef: { contains: query, mode: 'insensitive' } },
            },
          },
        ],
      },
      include: {
        wallet: { select: { address: true } },
        virtualAccount: { select: { providerRef: true, accountNumber: true } },
      },
      take: limit,
    })) as Record<string, any>[]

    const results = candidates.map((u) => {
      const emailStr = typeof u.email === 'string' ? u.email : ''
      const nameStr = typeof u.name === 'string' ? u.name : ''
      const walletAddr =
        typeof u.wallet?.address === 'string' ? u.wallet.address : null
      const externalRef =
        (typeof u.virtualAccount?.providerRef === 'string' &&
          u.virtualAccount.providerRef) ||
        (typeof u.privyId === 'string' ? u.privyId : null)

      const matchedFields: string[] = []
      if (
        emailStr.toLowerCase().includes(normalizedQuery) ||
        computeSearchHash(emailStr) === queryHash ||
        u.emailHash === queryHash
      ) {
        matchedFields.push('email')
      }
      if (nameStr.toLowerCase().includes(normalizedQuery)) {
        matchedFields.push('displayName')
      }
      if (walletAddr && walletAddr.toLowerCase().includes(normalizedQuery)) {
        matchedFields.push('walletAddress')
      }
      if (
        (externalRef && externalRef.toLowerCase().includes(normalizedQuery)) ||
        (typeof u.referralCode === 'string' &&
          u.referralCode.toLowerCase().includes(normalizedQuery))
      ) {
        matchedFields.push('externalReference')
      }

      const emailHash = emailStr ? computeSearchHash(emailStr) : null

      if (shouldUnmaskPii) {
        return {
          id: u.id,
          email: emailStr,
          emailHash,
          displayName: u.name ?? null,
          phone: u.phone ?? null,
          walletAddress: walletAddr,
          externalReference: externalRef,
          role: u.role ?? 'freelancer',
          matchedFields,
          piiRedacted: false,
        }
      }

      return {
        id: u.id,
        email: redactEmail(emailStr),
        emailHash,
        displayName: redactDisplayName(u.name),
        phone: redactPhone(u.phone),
        walletAddress: walletAddr,
        externalReference: externalRef,
        role: u.role ?? 'freelancer',
        matchedFields,
        piiRedacted: true,
      }
    })

    const db = prisma as unknown as {
      auditLog?: {
        create: (args: unknown) => Promise<Record<string, any>>
      }
    }

    if (shouldUnmaskPii) {
      await db.auditLog?.create({
        data: {
          actorId: auth.admin.id,
          actorEmail: auth.admin.email,
          action: 'admin.users.search.unmasked',
          resourceType: 'UserDirectory',
          resourceId: queryHash.slice(0, 16),
          metadata: {
            query,
            unmaskReason,
            resultCount: results.length,
            matchedUserIds: results.map((r) => r.id),
          },
        },
      })
    }

    return NextResponse.json(
      {
        query,
        queryVectorHash: queryHash,
        piiRedacted: !shouldUnmaskPii,
        unmaskReason: shouldUnmaskPii ? unmaskReason : null,
        results,
        count: results.length,
      },
      {
        status: 200,
        headers: {
          'X-RateLimit-Limit': String(ADMIN_SEARCH_RATE_LIMIT_MAX),
          'X-RateLimit-Remaining': String(quota.remaining),
        },
      },
    )
  } catch (err) {
    logger?.error?.({ err }, 'GET /api/admin/users/search error')
    return NextResponse.json(
      { error: 'Failed to search users' },
      { status: 500 },
    )
  }
}
