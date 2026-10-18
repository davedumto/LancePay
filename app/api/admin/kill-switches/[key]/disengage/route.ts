import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export interface CachedKillSwitchState {
  key: string
  engaged: boolean
  incidentReference: string
  engagedByAdminId: string
  engagedAt: string
}

const internalCacheMap = new Map<string, CachedKillSwitchState>()

export const killSwitchSharedCache = {
  get(key: string): CachedKillSwitchState | undefined {
    return internalCacheMap.get(key)
  },
  set(key: string, value: CachedKillSwitchState): void {
    internalCacheMap.set(key, value)
  },
  delete(key: string): boolean {
    return internalCacheMap.delete(key)
  },
  clear(): void {
    internalCacheMap.clear()
  },
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
    normalizedRole !== 'ops_admin'
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
 * POST /api/admin/kill-switches/[key]/disengage
 * Lifts a global kill switch after an incident:
 * - Requires the caller to reference a resolved incident and rejects if the incident is still open.
 * - Updates the database row first and clears the shared cache entry ONLY after the DB update succeeds.
 * - Records the disengaging admin plus elapsed duration so postmortems have first-class data.
 */
export async function POST(
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
        { error: 'Kill switch key is required' },
        { status: 400 },
      )
    }

    let body: Record<string, unknown>
    try {
      body = (await req.json()) as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const incidentReference =
      (typeof body.incidentReference === 'string' &&
        body.incidentReference.trim()) ||
      (typeof body.incidentId === 'string' && body.incidentId.trim()) ||
      (typeof body.incidentRef === 'string' && body.incidentRef.trim()) ||
      ''

    if (!incidentReference) {
      return NextResponse.json(
        {
          error: 'incidentReference is required to disengage a kill switch',
          code: 'INCIDENT_REFERENCE_REQUIRED',
        },
        { status: 400 },
      )
    }

    const resolutionNotes =
      typeof body.resolutionNotes === 'string' && body.resolutionNotes.trim()
        ? body.resolutionNotes.trim()
        : typeof body.reason === 'string' && body.reason.trim()
          ? body.reason.trim()
          : null

    const db = prisma as unknown as {
      killSwitch?: {
        findUnique: (args: unknown) => Promise<Record<string, any> | null>
        update: (args: unknown) => Promise<Record<string, any>>
      }
      incident?: {
        findUnique: (args: unknown) => Promise<Record<string, any> | null>
      }
      killSwitchAudit?: {
        create: (args: unknown) => Promise<Record<string, any>>
      }
      auditLog?: {
        create: (args: unknown) => Promise<Record<string, any>>
      }
    }

    const existingSwitch = await db.killSwitch?.findUnique({
      where: { key },
    })

    if (!existingSwitch) {
      return NextResponse.json(
        { error: `Kill switch "${key}" not found`, code: 'KILL_SWITCH_NOT_FOUND' },
        { status: 404 },
      )
    }

    if (
      existingSwitch.engaged === false ||
      existingSwitch.status === 'disengaged'
    ) {
      return NextResponse.json(
        {
          error: `Kill switch "${key}" is already disengaged`,
          code: 'KILL_SWITCH_ALREADY_DISENGAGED',
        },
        { status: 409 },
      )
    }

    const incident = await db.incident?.findUnique({
      where: { id: incidentReference },
    })

    if (!incident) {
      return NextResponse.json(
        {
          error: `Referenced incident "${incidentReference}" not found`,
          code: 'INCIDENT_NOT_FOUND',
        },
        { status: 404 },
      )
    }

    const incidentStatus = String(incident.status ?? '').toLowerCase()
    if (incidentStatus !== 'resolved' && incidentStatus !== 'closed') {
      return NextResponse.json(
        {
          error: `Cannot disengage kill switch "${key}" while incident "${incidentReference}" is still ${incident.status ?? 'open'}`,
          code: 'INCIDENT_STILL_OPEN',
          incidentReference,
          incidentStatus: incident.status ?? 'open',
        },
        { status: 409 },
      )
    }

    const disengagedAt = new Date()
    const engagedAtDate = existingSwitch.engagedAt
      ? new Date(existingSwitch.engagedAt)
      : disengagedAt
    const elapsedDurationMs = Math.max(
      0,
      disengagedAt.getTime() - engagedAtDate.getTime(),
    )
    const elapsedDurationSeconds = Math.round(elapsedDurationMs / 1000)

    // 1. Update database row FIRST before touching the shared cache
    const updatedSwitch = await db.killSwitch!.update({
      where: { key },
      data: {
        engaged: false,
        status: 'disengaged',
        disengagedByAdminId: auth.admin.id,
        disengagedByEmail: auth.admin.email,
        disengagedAt,
        resolvedIncidentRef: incidentReference,
        resolutionNotes,
        elapsedDurationMs,
        elapsedDurationSeconds,
      },
    })

    // 2. Clear shared cache entry ONLY after DB row update has completed
    killSwitchSharedCache.delete(key)

    // 3. Record postmortem audit log with disengaging admin + elapsed time
    const auditRecord = await db.killSwitchAudit?.create({
      data: {
        killSwitchKey: key,
        action: 'disengage',
        incidentReference,
        disengagedByAdminId: auth.admin.id,
        disengagedByEmail: auth.admin.email,
        engagedAt: engagedAtDate,
        disengagedAt,
        elapsedDurationMs,
        elapsedDurationSeconds,
        resolutionNotes,
      },
    })

    await db.auditLog?.create({
      data: {
        actorId: auth.admin.id,
        actorEmail: auth.admin.email,
        action: 'admin.kill_switch.disengage',
        resourceType: 'KillSwitch',
        resourceId: key,
        metadata: {
          key,
          incidentReference,
          incidentStatus: incident.status,
          disengagedByAdminId: auth.admin.id,
          engagedAt: engagedAtDate.toISOString(),
          disengagedAt: disengagedAt.toISOString(),
          elapsedDurationMs,
          elapsedDurationSeconds,
          resolutionNotes,
        },
      },
    })

    logger?.info?.(
      {
        key,
        incidentReference,
        disengagedByAdminId: auth.admin.id,
        elapsedDurationMs,
        elapsedDurationSeconds,
      },
      'POST /api/admin/kill-switches/[key]/disengage lifted global kill switch',
    )

    return NextResponse.json({
      killSwitch: {
        ...updatedSwitch,
        key,
        engaged: false,
        status: 'disengaged',
        incidentReference,
        disengagedByAdminId: auth.admin.id,
        disengagedByEmail: auth.admin.email,
        engagedAt: engagedAtDate.toISOString(),
        disengagedAt: disengagedAt.toISOString(),
        elapsedDurationMs,
        elapsedDurationSeconds,
      },
      postmortem: {
        incidentReference,
        disengagedByAdminId: auth.admin.id,
        disengagedByEmail: auth.admin.email,
        engagedAt: engagedAtDate.toISOString(),
        disengagedAt: disengagedAt.toISOString(),
        elapsedDurationMs,
        elapsedDurationSeconds,
        auditId: auditRecord?.id ?? null,
      },
      cacheCleared: true,
    })
  } catch (err) {
    logger?.error?.(
      { err },
      'POST /api/admin/kill-switches/[key]/disengage error',
    )
    return NextResponse.json(
      { error: 'Failed to disengage kill switch' },
      { status: 500 },
    )
  }
}
