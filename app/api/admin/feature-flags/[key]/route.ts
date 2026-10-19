import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { verifyAuthToken } from '@/lib/auth'

const updateFeatureFlagSchema = z.object({
  concurrencyToken: z.union([z.string(), z.number()]).optional(),
  rolloutPercentage: z.number().int().min(0).max(100).optional(),
  cohortRules: z.array(z.record(z.unknown())).optional(),
  enabled: z.boolean().optional(),
  killed: z.boolean().optional(),
  reason: z.string().trim().optional(),
})

async function getAuthenticatedAdmin(
  request: NextRequest,
): Promise<{ id: string; email: string; role: string; canRollback: boolean } | null> {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null

  const claims = await verifyAuthToken(authToken)
  if (!claims?.userId) return null

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true, email: true, role: true },
  })

  if (!user || (user.role !== 'admin' && user.role !== 'superadmin')) {
    return null
  }

  const roleHeader = request.headers.get('x-admin-role')?.toLowerCase()
  const canRollback =
    user.role === 'superadmin' ||
    roleHeader === 'rollback' ||
    roleHeader === 'admin_rollback'

  return { id: user.id, email: user.email, role: user.role, canRollback }
}

/**
 * PATCH /api/admin/feature-flags/[key]
 *
 * Updates rollout percentage, cohort rules, or kill status of an existing flag.
 * - Requires an optimistic concurrency token to prevent concurrent clobbering.
 * - Rejects rollout percentage decreases unless caller holds the rollback role.
 * - Appends a change entry (audit log) preserving full recoverable history.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  try {
    const { key } = await params
    if (!key || typeof key !== 'string' || key.trim() === '') {
      return NextResponse.json({ error: 'Feature flag key is required' }, { status: 400 })
    }

    const cleanKey = key.trim().toLowerCase()

    const admin = await getAuthenticatedAdmin(request)
    if (!admin) {
      return NextResponse.json(
        { error: 'Forbidden: admin access required', code: 'FORBIDDEN' },
        { status: 403 },
      )
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = updateFeatureFlagSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      )
    }

    const updates = parsed.data
    const tokenFromHeader = request.headers.get('if-match')?.replace(/^"|"$/g, '')
    const concurrencyToken = updates.concurrencyToken ?? tokenFromHeader

    if (concurrencyToken === undefined || concurrencyToken === null || concurrencyToken === '') {
      return NextResponse.json(
        {
          error: 'Optimistic concurrency token is required (concurrencyToken in body or If-Match header)',
          code: 'CONCURRENCY_TOKEN_REQUIRED',
        },
        { status: 400 },
      )
    }

    const flag = await prisma.featureFlag.findUnique({
      where: { key: cleanKey },
    })

    if (!flag) {
      return NextResponse.json(
        { error: `Feature flag '${cleanKey}' not found`, code: 'FLAG_NOT_FOUND' },
        { status: 404 },
      )
    }

    // Verify optimistic concurrency token against version or updatedAt
    const matchesVersion = String(flag.version) === String(concurrencyToken)
    const matchesUpdatedAt = flag.updatedAt.toISOString() === String(concurrencyToken)

    if (!matchesVersion && !matchesUpdatedAt) {
      return NextResponse.json(
        {
          error: 'Optimistic concurrency check failed: flag was modified by another process',
          code: 'CONCURRENCY_CONFLICT',
          currentVersion: flag.version,
          currentUpdatedAt: flag.updatedAt.toISOString(),
        },
        { status: 409 },
      )
    }

    // Reject rollout percentage decrease unless caller holds rollback role
    if (
      typeof updates.rolloutPercentage === 'number' &&
      updates.rolloutPercentage < flag.rolloutPercentage &&
      !admin.canRollback
    ) {
      return NextResponse.json(
        {
          error: `Rollout percentage decrease from ${flag.rolloutPercentage}% to ${updates.rolloutPercentage}% requires rollback role`,
          code: 'ROLLBACK_ROLE_REQUIRED',
          currentRolloutPercentage: flag.rolloutPercentage,
          requestedRolloutPercentage: updates.rolloutPercentage,
        },
        { status: 403 },
      )
    }

    const priorConfig = {
      rolloutPercentage: flag.rolloutPercentage,
      cohortRules: flag.cohortRules,
      enabled: flag.enabled,
      killed: flag.killed,
      version: flag.version,
    }

    const newRollout = updates.rolloutPercentage ?? flag.rolloutPercentage
    const newCohorts = updates.cohortRules ?? (flag.cohortRules as any)
    const newEnabled = updates.enabled ?? flag.enabled
    const newKilled = updates.killed ?? flag.killed
    const nextVersion = flag.version + 1

    const newConfig = {
      rolloutPercentage: newRollout,
      cohortRules: newCohorts,
      enabled: newEnabled,
      killed: newKilled,
      version: nextVersion,
    }

    const changeEntry = {
      version: nextVersion,
      changedById: admin.id,
      changedAt: new Date().toISOString(),
      action: updates.killed ? 'kill_switch' : 'update_rollout',
      priorConfig,
      newConfig,
      reason: updates.reason || null,
    }

    const existingChangeLog = Array.isArray(flag.changeLog) ? (flag.changeLog as any[]) : []
    const updatedChangeLog = [...existingChangeLog, changeEntry]

    // Update flag and append change history in transaction
    const result = await prisma.$transaction(async (tx) => {
      await tx.featureFlagChange.create({
        data: {
          featureFlagId: flag.id,
          changedById: admin.id,
          action: updates.killed ? 'kill_switch' : 'update_rollout',
          priorConfig: priorConfig as any,
          newConfig: newConfig as any,
          reason: updates.reason || null,
        },
      })

      return tx.featureFlag.update({
        where: { key: cleanKey },
        data: {
          rolloutPercentage: newRollout,
          cohortRules: newCohorts,
          enabled: newEnabled,
          killed: newKilled,
          version: nextVersion,
          changeLog: updatedChangeLog as any,
        },
        select: {
          id: true,
          key: true,
          name: true,
          rolloutPercentage: true,
          cohortRules: true,
          enabled: true,
          killed: true,
          version: true,
          updatedAt: true,
        },
      })
    })

    logger.info(
      { key: cleanKey, version: nextVersion, adminId: admin.id },
      'Feature flag updated with change log history appended',
    )

    return NextResponse.json(
      {
        featureFlag: result,
        changeEntry,
      },
      { status: 200 },
    )
  } catch (error) {
    logger.error({ err: error }, 'PATCH /api/admin/feature-flags/[key] error')
    return NextResponse.json({ error: 'Failed to update feature flag' }, { status: 500 })
  }
}
