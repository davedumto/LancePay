import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { verifyAuthToken } from '@/lib/auth'
import { sharedCache } from '@/lib/shared-cache'

const engageKillSwitchSchema = z.object({
  incidentRef: z.string().trim().min(1, 'incidentRef is required'),
  reason: z.string().trim().max(500).optional(),
  subsystem: z.string().trim().optional(),
})

async function getAuthenticatedAdmin(
  request: NextRequest,
): Promise<{ id: string; email: string } | null> {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null

  const claims = await verifyAuthToken(authToken)
  if (!claims?.userId) return null

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true, email: true, role: true },
  })

  if (!user || user.role !== 'admin') {
    return null
  }

  return { id: user.id, email: user.email }
}

/**
 * POST /api/admin/kill-switches/[key]/engage
 *
 * Engages a global kill switch for a subsystem (e.g. withdrawals, payouts, swap).
 * - Requires an incident reference connected to an open incident.
 * - Records before and after snapshots of the switch for postmortem audits.
 * - Propagates engage state to shared cache for low-latency handler evaluation.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  try {
    const { key } = await params
    if (!key || typeof key !== 'string' || key.trim() === '') {
      return NextResponse.json({ error: 'Kill switch key is required' }, { status: 400 })
    }

    const cleanKey = key.trim().toLowerCase()

    const admin = await getAuthenticatedAdmin(request)
    if (!admin) {
      return NextResponse.json(
        { error: 'Forbidden: platform admin access required', code: 'FORBIDDEN' },
        { status: 403 },
      )
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = engageKillSwitchSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Incident reference is required to engage kill switch',
          code: 'INCIDENT_REF_REQUIRED',
          details: parsed.error.flatten().fieldErrors,
        },
        { status: 400 },
      )
    }

    const { incidentRef, reason, subsystem } = parsed.data

    // Verify referenced incident is open if incident record exists
    const incident = await prisma.incident.findUnique({
      where: { reference: incidentRef },
      select: { id: true, reference: true, status: true },
    })

    if (incident && (incident.status === 'resolved' || incident.status === 'closed')) {
      return NextResponse.json(
        {
          error: `Referenced incident '${incidentRef}' is already ${incident.status}. Kill switches can only be engaged for open incidents.`,
          code: 'INCIDENT_ALREADY_RESOLVED',
          incidentStatus: incident.status,
        },
        { status: 400 },
      )
    }

    const now = new Date()

    // Find existing switch to take before snapshot
    const existing = await prisma.killSwitch.findUnique({
      where: { key: cleanKey },
    })

    if (existing && existing.status === 'engaged') {
      return NextResponse.json(
        {
          error: `Kill switch '${cleanKey}' is already engaged for incident '${existing.incidentRef}'`,
          code: 'SWITCH_ALREADY_ENGAGED',
          killSwitch: existing,
        },
        { status: 409 },
      )
    }

    const beforeSnapshot = existing
      ? {
          status: existing.status,
          incidentRef: existing.incidentRef,
          engagedAt: existing.engagedAt,
          disengagedAt: existing.disengagedAt,
          subsystem: existing.subsystem,
        }
      : {
          status: 'disengaged',
          incidentRef: null,
          engagedAt: null,
          subsystem: subsystem || cleanKey,
        }

    const afterSnapshot = {
      status: 'engaged',
      incidentRef,
      engagedAt: now.toISOString(),
      engagedById: admin.id,
      subsystem: subsystem || existing?.subsystem || cleanKey,
      reason: reason || null,
    }

    // Persist to database
    const killSwitch = await prisma.killSwitch.upsert({
      where: { key: cleanKey },
      create: {
        key: cleanKey,
        subsystem: subsystem || cleanKey,
        status: 'engaged',
        incidentRef,
        reason: reason || null,
        beforeSnapshot: beforeSnapshot as any,
        afterSnapshot: afterSnapshot as any,
        engagedAt: now,
        engagedById: admin.id,
        disengagedAt: null,
        disengagedById: null,
        elapsedSeconds: null,
      },
      update: {
        status: 'engaged',
        incidentRef,
        reason: reason || null,
        beforeSnapshot: beforeSnapshot as any,
        afterSnapshot: afterSnapshot as any,
        engagedAt: now,
        engagedById: admin.id,
        disengagedAt: null,
        disengagedById: null,
        elapsedSeconds: null,
      },
      select: {
        id: true,
        key: true,
        subsystem: true,
        status: true,
        incidentRef: true,
        reason: true,
        beforeSnapshot: true,
        afterSnapshot: true,
        engagedAt: true,
        engagedById: true,
        updatedAt: true,
      },
    })

    // Propagate engaged state to shared cache
    sharedCache.set(`killswitch:${cleanKey}`, {
      status: 'engaged',
      incidentRef,
      engagedAt: now.toISOString(),
      subsystem: killSwitch.subsystem,
    })

    logger.warn(
      { key: cleanKey, incidentRef, adminId: admin.id },
      'Global kill switch ENGAGED',
    )

    return NextResponse.json({ killSwitch, cacheUpdated: true }, { status: 200 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/admin/kill-switches/[key]/engage error')
    return NextResponse.json({ error: 'Failed to engage kill switch' }, { status: 500 })
  }
}
