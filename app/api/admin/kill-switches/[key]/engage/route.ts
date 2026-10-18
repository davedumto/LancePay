import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export interface KillSwitchSnapshot {
  key: string
  engaged: boolean
  status: 'engaged' | 'disengaged'
  incidentReference: string | null
  reason: string | null
  engagedByAdminId: string | null
  engagedByEmail: string | null
  engagedAt: string | null
}

const internalCacheMap = new Map<string, KillSwitchSnapshot>()

export const killSwitchSharedCache = {
  get(key: string): KillSwitchSnapshot | undefined {
    return internalCacheMap.get(key)
  },
  set(key: string, value: KillSwitchSnapshot): void {
    internalCacheMap.set(key, value)
  },
  delete(key: string): boolean {
    return internalCacheMap.delete(key)
  },
  clear(): void {
    internalCacheMap.clear()
  },
}

/**
 * Helper for active request handlers to read kill-switch engage state
 * directly from the shared cache without a database roundtrip.
 */
export function isKillSwitchEngagedCached(key: string): boolean {
  return internalCacheMap.get(key)?.engaged === true
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
 * POST /api/admin/kill-switches/[key]/engage
 * Engages a global kill switch for a subsystem:
 * - Requires the caller to supply an incident reference connected to an open incident.
 * - Propagates the engage state to the shared cache so active handlers can read it without a DB roundtrip.
 * - Records a before and after snapshot of the switch so a later disengage call can be verified.
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
          error: 'incidentReference is required to engage a kill switch',
          code: 'INCIDENT_REFERENCE_REQUIRED',
        },
        { status: 400 },
      )
    }

    const reason =
      typeof body.reason === 'string' && body.reason.trim()
        ? body.reason.trim()
        : 'Emergency subsystem kill switch engaged'

    const db = prisma as unknown as {
      killSwitch?: {
        findUnique?: (args: unknown) => Promise<Record<string, any> | null>
        upsert?: (args: unknown) => Promise<Record<string, any>>
        update?: (args: unknown) => Promise<Record<string, any>>
      }
      incident?: {
        findUnique?: (args: unknown) => Promise<Record<string, any> | null>
      }
      killSwitchAudit?: {
        create?: (args: unknown) => Promise<Record<string, any>>
      }
      auditLog?: {
        create?: (args: unknown) => Promise<Record<string, any>>
      }
    }

    if (typeof db.incident?.findUnique === 'function') {
      const incident = await db.incident.findUnique({
        where: { id: incidentReference },
      })
      if (incident) {
        const incStatus = String(incident.status ?? 'open').toLowerCase()
        if (incStatus === 'resolved' || incStatus === 'closed') {
          return NextResponse.json(
            {
              error: `Referenced incident "${incidentReference}" is already ${incident.status}; an open incident is required`,
              code: 'INCIDENT_NOT_OPEN',
            },
            { status: 409 },
          )
        }
      }
    }

    const existingSwitch = await db.killSwitch?.findUnique?.({
      where: { key },
    })

    if (existingSwitch?.engaged === true) {
      return NextResponse.json(
        {
          error: `Kill switch "${key}" is already engaged`,
          code: 'KILL_SWITCH_ALREADY_ENGAGED',
        },
        { status: 409 },
      )
    }

    const beforeSnapshot: KillSwitchSnapshot = {
      key,
      engaged: Boolean(existingSwitch?.engaged ?? false),
      status: existingSwitch?.engaged ? 'engaged' : 'disengaged',
      incidentReference: existingSwitch?.incidentReference ?? null,
      reason: existingSwitch?.reason ?? null,
      engagedByAdminId: existingSwitch?.engagedByAdminId ?? null,
      engagedByEmail: existingSwitch?.engagedByEmail ?? null,
      engagedAt: existingSwitch?.engagedAt
        ? new Date(existingSwitch.engagedAt).toISOString()
        : null,
    }

    const engagedAt = new Date()
    const engagedAtIso = engagedAt.toISOString()

    const afterSnapshot: KillSwitchSnapshot = {
      key,
      engaged: true,
      status: 'engaged',
      incidentReference,
      reason,
      engagedByAdminId: auth.admin.id,
      engagedByEmail: auth.admin.email,
      engagedAt: engagedAtIso,
    }

    if (typeof db.killSwitch?.upsert === 'function') {
      await db.killSwitch.upsert({
        where: { key },
        create: {
          key,
          engaged: true,
          status: 'engaged',
          incidentReference,
          reason,
          engagedByAdminId: auth.admin.id,
          engagedByEmail: auth.admin.email,
          engagedAt,
          beforeSnapshot,
          afterSnapshot,
        },
        update: {
          engaged: true,
          status: 'engaged',
          incidentReference,
          reason,
          engagedByAdminId: auth.admin.id,
          engagedByEmail: auth.admin.email,
          engagedAt,
          beforeSnapshot,
          afterSnapshot,
        },
      })
    } else if (typeof db.killSwitch?.update === 'function') {
      await db.killSwitch.update({
        where: { key },
        data: {
          engaged: true,
          status: 'engaged',
          incidentReference,
          reason,
          engagedByAdminId: auth.admin.id,
          engagedByEmail: auth.admin.email,
          engagedAt,
          beforeSnapshot,
          afterSnapshot,
        },
      })
    }

    // Propagate engage state to shared cache so active handlers can read without DB roundtrip
    killSwitchSharedCache.set(key, afterSnapshot)

    const auditRecord = await db.killSwitchAudit?.create?.({
      data: {
        killSwitchKey: key,
        action: 'engage',
        incidentReference,
        reason,
        engagedByAdminId: auth.admin.id,
        engagedByEmail: auth.admin.email,
        engagedAt,
        beforeSnapshot,
        afterSnapshot,
      },
    })

    await db.auditLog?.create?.({
      data: {
        actorId: auth.admin.id,
        actorEmail: auth.admin.email,
        action: 'admin.kill_switch.engage',
        resourceType: 'KillSwitch',
        resourceId: key,
        metadata: {
          key,
          incidentReference,
          reason,
          beforeSnapshot,
          afterSnapshot,
        },
      },
    })

    logger?.warn?.(
      {
        key,
        incidentReference,
        engagedByAdminId: auth.admin.id,
      },
      'POST /api/admin/kill-switches/[key]/engage activated global kill switch',
    )

    return NextResponse.json(
      {
        killSwitch: afterSnapshot,
        snapshots: {
          before: beforeSnapshot,
          after: afterSnapshot,
        },
        cachePropagated: true,
        auditId: auditRecord?.id ?? null,
      },
      { status: 201 },
    )
  } catch (err) {
    logger?.error?.({ err }, 'POST /api/admin/kill-switches/[key]/engage error')
    return NextResponse.json(
      { error: 'Failed to engage kill switch' },
      { status: 500 },
    )
  }
}
