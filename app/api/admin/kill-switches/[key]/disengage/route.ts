import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { verifyAuthToken } from '@/lib/auth'
import { sharedCache } from '@/lib/shared-cache'

const disengageKillSwitchSchema = z.object({
  incidentRef: z.string().trim().min(1, 'incidentRef is required'),
  resolutionSummary: z.string().trim().optional(),
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
 * POST /api/admin/kill-switches/[key]/disengage
 *
 * Lifts a previously engaged kill switch once an incident has been declared resolved.
 * - Requires referencing a resolved incident and rejects if still open.
 * - Updates the database row first, recording the disengaging admin and elapsed time.
 * - Clears shared cache entry only AFTER database row update completes.
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

    const parsed = disengageKillSwitchSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Resolved incident reference is required to disengage kill switch',
          code: 'INCIDENT_REF_REQUIRED',
          details: parsed.error.flatten().fieldErrors,
        },
        { status: 400 },
      )
    }

    const { incidentRef, resolutionSummary } = parsed.data

    // Verify referenced incident exists and is resolved
    const incident = await prisma.incident.findUnique({
      where: { reference: incidentRef },
      select: { id: true, reference: true, status: true },
    })

    if (!incident) {
      return NextResponse.json(
        {
          error: `Referenced incident '${incidentRef}' not found`,
          code: 'INCIDENT_NOT_FOUND',
        },
        { status: 404 },
      )
    }

    if (incident.status !== 'resolved' && incident.status !== 'closed') {
      return NextResponse.json(
        {
          error: `Referenced incident '${incidentRef}' is still ${incident.status}. Kill switch cannot be disengaged until incident is resolved.`,
          code: 'INCIDENT_NOT_RESOLVED',
          incidentStatus: incident.status,
        },
        { status: 400 },
      )
    }

    const existing = await prisma.killSwitch.findUnique({
      where: { key: cleanKey },
    })

    if (!existing || existing.status !== 'engaged') {
      return NextResponse.json(
        {
          error: `Kill switch '${cleanKey}' is not currently engaged`,
          code: 'SWITCH_NOT_ENGAGED',
        },
        { status: 409 },
      )
    }

    const now = new Date()
    const engagedAt = existing.engagedAt ? new Date(existing.engagedAt) : now
    const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - engagedAt.getTime()) / 1000))

    // 1. Update DB row FIRST before clearing cache to prevent race conditions
    const updatedSwitch = await prisma.killSwitch.update({
      where: { key: cleanKey },
      data: {
        status: 'disengaged',
        disengagedAt: now,
        disengagedById: admin.id,
        elapsedSeconds,
        reason: resolutionSummary || existing.reason,
      },
      select: {
        id: true,
        key: true,
        subsystem: true,
        status: true,
        incidentRef: true,
        engagedAt: true,
        engagedById: true,
        disengagedAt: true,
        disengagedById: true,
        elapsedSeconds: true,
        reason: true,
        updatedAt: true,
      },
    })

    // 2. Clear cache entry AFTER DB update succeeds
    sharedCache.delete(`killswitch:${cleanKey}`)

    logger.info(
      { key: cleanKey, incidentRef, adminId: admin.id, elapsedSeconds },
      'Global kill switch DISENGAGED',
    )

    return NextResponse.json(
      {
        killSwitch: updatedSwitch,
        elapsedSeconds,
        cacheCleared: true,
      },
      { status: 200 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/admin/kill-switches/[key]/disengage error')
    return NextResponse.json({ error: 'Failed to disengage kill switch' }, { status: 500 })
  }
}
