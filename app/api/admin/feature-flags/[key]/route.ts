import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const ADMIN_ROLES = new Set([
  'admin',
  'ops_admin',
  'release_manager',
  'rollback_admin',
  'super_admin',
])

const ROLLBACK_ROLES = new Set([
  'rollback_admin',
  'release_manager',
  'super_admin',
])

function checkHasRollbackRole(
  role: string,
  claims: Record<string, unknown>,
): boolean {
  if (ROLLBACK_ROLES.has(role)) return true
  const rolesArr = Array.isArray(claims.roles) ? claims.roles : []
  const permsArr = Array.isArray(claims.permissions) ? claims.permissions : []
  if (
    rolesArr.some(
      (r) =>
        typeof r === 'string' &&
        (ROLLBACK_ROLES.has(r.toLowerCase()) || r.toLowerCase() === 'rollback'),
    )
  ) {
    return true
  }
  if (
    permsArr.some(
      (p) =>
        typeof p === 'string' &&
        (p.toLowerCase() === 'rollback' ||
          p.toLowerCase() === 'feature_flag:rollback'),
    )
  ) {
    return true
  }
  return false
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

  const hasRollbackRole = checkHasRollbackRole(normalizedRole, claims)

  return {
    error: null,
    status: 200 as const,
    admin: {
      id: adminId,
      email: adminEmail,
      role: normalizedRole,
      hasRollbackRole,
    },
  }
}

function normalizeToken(raw: unknown): string {
  if (typeof raw === 'string') {
    return raw.trim().replace(/^W\/|^"|"$/g, '')
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return String(raw)
  }
  return ''
}

/**
 * PATCH /api/admin/feature-flags/[key]
 * Updates a feature flag rollout plan:
 * - Requires an optimistic concurrency token (`concurrencyToken` / `expectedVersion` / `If-Match`)
 *   so stale updates cannot clobber concurrent changes (409 STALE_CONCURRENCY_TOKEN).
 * - Rejects rollout percentage decreases unless the caller holds the rollback role (403 ROLLBACK_ROLE_REQUIRED).
 * - Appends a change entry rather than overwriting prior configuration so the full history is recoverable.
 */
export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ key: string }> | { key: string } },
) {
  try {
    const auth = await requireAdminActor(req)
    if (auth.error || !auth.admin) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const resolvedParams = await Promise.resolve(context.params)
    const key = resolvedParams?.key?.trim() || ''
    if (!key) {
      return NextResponse.json(
        { error: 'Feature flag key is required' },
        { status: 400 },
      )
    }

    let body: Record<string, unknown>
    try {
      body = (await req.json()) as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const headerIfMatch = req.headers.get('if-match')
    const suppliedToken =
      normalizeToken(body.concurrencyToken) ||
      normalizeToken(body.expectedVersion) ||
      normalizeToken(body.version) ||
      normalizeToken(headerIfMatch)

    if (!suppliedToken) {
      return NextResponse.json(
        {
          error:
            'Optimistic concurrency token (concurrencyToken, expectedVersion, or If-Match) is required',
          code: 'CONCURRENCY_TOKEN_REQUIRED',
        },
        { status: 400 },
      )
    }

    const db = prisma as unknown as {
      featureFlag?: {
        findUnique: (args: unknown) => Promise<Record<string, any> | null>
        update: (args: unknown) => Promise<Record<string, any>>
      }
      featureFlagRevision?: {
        create: (args: unknown) => Promise<Record<string, any>>
      }
      auditLog?: {
        create: (args: unknown) => Promise<Record<string, any>>
      }
    }

    const existingFlag = await db.featureFlag?.findUnique({
      where: { key },
    })

    if (!existingFlag) {
      return NextResponse.json(
        { error: `Feature flag "${key}" not found`, code: 'FEATURE_FLAG_NOT_FOUND' },
        { status: 404 },
      )
    }

    const currentVersion = Number(existingFlag.version ?? 1)
    const currentToken = String(
      existingFlag.concurrencyToken ?? `v${currentVersion}`,
    )

    const tokenMatches =
      suppliedToken === currentToken ||
      suppliedToken === String(currentVersion) ||
      suppliedToken === `v${currentVersion}`

    if (!tokenMatches) {
      return NextResponse.json(
        {
          error:
            'Optimistic concurrency token mismatch: feature flag was modified concurrently',
          code: 'STALE_CONCURRENCY_TOKEN',
          currentVersion,
          currentConcurrencyToken: currentToken,
        },
        { status: 409 },
      )
    }

    const currentRolloutPercentage = Number(
      existingFlag.rolloutPercentage ?? 0,
    )
    const nextRolloutPercentage =
      body.rolloutPercentage !== undefined
        ? Number(body.rolloutPercentage)
        : currentRolloutPercentage

    if (
      !Number.isFinite(nextRolloutPercentage) ||
      nextRolloutPercentage < 0 ||
      nextRolloutPercentage > 100
    ) {
      return NextResponse.json(
        {
          error: 'rolloutPercentage must be a number between 0 and 100',
          code: 'INVALID_ROLLOUT_PERCENTAGE',
        },
        { status: 400 },
      )
    }

    // Reject rollout percentage decreases unless caller holds the rollback role
    if (
      nextRolloutPercentage < currentRolloutPercentage &&
      !auth.admin.hasRollbackRole
    ) {
      return NextResponse.json(
        {
          error:
            'Decreasing rolloutPercentage requires the rollback role so partial launches cannot silently shrink',
          code: 'ROLLBACK_ROLE_REQUIRED',
          previousPercentage: currentRolloutPercentage,
          requestedPercentage: nextRolloutPercentage,
        },
        { status: 403 },
      )
    }

    const nextEnabled =
      typeof body.enabled === 'boolean'
        ? body.enabled
        : Boolean(existingFlag.enabled ?? true)
    const nextCohortRules = Array.isArray(body.cohortRules)
      ? body.cohortRules
      : Array.isArray(existingFlag.cohortRules)
        ? existingFlag.cohortRules
        : []
    const reason =
      typeof body.reason === 'string' && body.reason.trim()
        ? body.reason.trim()
        : null

    const nextVersion = currentVersion + 1
    const nextConcurrencyToken = `v${nextVersion}_${crypto
      .randomBytes(6)
      .toString('hex')}`
    const now = new Date()

    const previousSnapshot = {
      enabled: Boolean(existingFlag.enabled ?? true),
      rolloutPercentage: currentRolloutPercentage,
      cohortRules: existingFlag.cohortRules ?? [],
      version: currentVersion,
      concurrencyToken: currentToken,
    }

    const nextSnapshot = {
      enabled: nextEnabled,
      rolloutPercentage: nextRolloutPercentage,
      cohortRules: nextCohortRules,
      version: nextVersion,
      concurrencyToken: nextConcurrencyToken,
    }

    const changeEntry = {
      version: nextVersion,
      changedAt: now.toISOString(),
      changedByAdminId: auth.admin.id,
      changedByEmail: auth.admin.email,
      reason,
      previousConfig: previousSnapshot,
      newConfig: nextSnapshot,
    }

    const priorHistory = Array.isArray(existingFlag.changeHistory)
      ? existingFlag.changeHistory
      : []
    const updatedHistory = [...priorHistory, changeEntry]

    // Append change revision entry in dedicated table as well as flag history array
    const revisionRow = await db.featureFlagRevision?.create({
      data: {
        flagKey: key,
        version: nextVersion,
        changedByAdminId: auth.admin.id,
        changedByEmail: auth.admin.email,
        reason,
        previousConfig: previousSnapshot,
        newConfig: nextSnapshot,
        createdAt: now,
      },
    })

    const updatedFlag = await db.featureFlag!.update({
      where: { key },
      data: {
        enabled: nextEnabled,
        rolloutPercentage: nextRolloutPercentage,
        cohortRules: nextCohortRules,
        version: nextVersion,
        concurrencyToken: nextConcurrencyToken,
        updatedByAdminId: auth.admin.id,
        changeHistory: updatedHistory,
      },
    })

    await db.auditLog?.create({
      data: {
        actorId: auth.admin.id,
        actorEmail: auth.admin.email,
        action: 'admin.feature_flag.update',
        resourceType: 'FeatureFlag',
        resourceId: key,
        metadata: changeEntry,
      },
    })

    logger?.info?.(
      {
        key,
        previousPercentage: currentRolloutPercentage,
        nextRolloutPercentage,
        nextVersion,
        adminId: auth.admin.id,
      },
      'PATCH /api/admin/feature-flags/[key] appended rollout change entry',
    )

    return NextResponse.json({
      featureFlag: {
        ...updatedFlag,
        key,
        enabled: nextEnabled,
        rolloutPercentage: nextRolloutPercentage,
        cohortRules: nextCohortRules,
        version: nextVersion,
        concurrencyToken: nextConcurrencyToken,
        changeHistory: updatedHistory,
      },
      changeEntry: {
        ...changeEntry,
        revisionId: revisionRow?.id ?? null,
      },
    })
  } catch (err) {
    logger?.error?.({ err }, 'PATCH /api/admin/feature-flags/[key] error')
    return NextResponse.json(
      { error: 'Failed to update feature flag rollout plan' },
      { status: 500 },
    )
  }
}
