import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// ── Constants ─────────────────────────────────────────────────────────────────

/** Minimum characters required in the dismissal reason. */
const MIN_REASON_LENGTH = 10

/** Roles permitted to dismiss structuring flags. */
const ALLOWED_ROLES = ['admin', 'compliance'] as const

// ── Helpers ───────────────────────────────────────────────────────────────────

type RouteContext = {
  params: Promise<{ id: string }> | { id: string }
}

async function resolveParams(context: RouteContext): Promise<{ id: string }> {
  const raw = context.params as { id: string } | Promise<{ id: string }>
  if (raw && typeof (raw as Promise<{ id: string }>).then === 'function') {
    return raw as Promise<{ id: string }>
  }
  return raw as { id: string }
}

// ── POST /api/compliance/structuring-detection/[id]/dismiss ───────────────────
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    // ── 1. Auth ───────────────────────────────────────────────────────────────
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    // ── 2. Role gate: admin or compliance only ────────────────────────────────
    if (!(ALLOWED_ROLES as readonly string[]).includes(user.role)) {
      return NextResponse.json(
        { error: 'Forbidden: admin or compliance role required' },
        { status: 403 },
      )
    }

    // ── 3. Resolve route param ────────────────────────────────────────────────
    const { id } = await resolveParams(context)
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

    // ── 4. Parse & validate body ──────────────────────────────────────────────
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { reason } = body as Record<string, unknown>

    if (
      !reason ||
      typeof reason !== 'string' ||
      reason.trim().length < MIN_REASON_LENGTH
    ) {
      return NextResponse.json(
        {
          error: `reason is required and must be at least ${MIN_REASON_LENGTH} characters`,
        },
        { status: 400 },
      )
    }

    // ── 5. Load the flag ──────────────────────────────────────────────────────
    const flag = await prisma.structuringFlag.findUnique({ where: { id } })

    if (!flag) {
      return NextResponse.json({ error: 'Structuring flag not found' }, { status: 404 })
    }

    // ── 6. Guard: block dismissal if already escalated ────────────────────────
    if (flag.status === 'escalated') {
      return NextResponse.json(
        {
          error:
            'Cannot dismiss a flag that has already been escalated to a formal case',
          currentStatus: flag.status,
        },
        { status: 409 },
      )
    }

    // ── 7. Guard: idempotent — already dismissed ──────────────────────────────
    if (flag.status === 'dismissed') {
      return NextResponse.json(
        {
          error: 'Flag has already been dismissed',
          currentStatus: flag.status,
        },
        { status: 409 },
      )
    }

    // ── 8. Persist the dismissal ──────────────────────────────────────────────
    const now = new Date()

    const updated = await prisma.structuringFlag.update({
      where: { id },
      data: {
        status: 'dismissed',
        dismissedById: user.id,
        dismissalReason: reason.trim(),
        dismissedAt: now,
      },
    })

    logger.error(
      { flagId: id, dismissedById: user.id },
      'POST /api/compliance/structuring-detection/[id]/dismiss — flag dismissed',
    )

    return NextResponse.json({
      flag: {
        id: updated.id,
        userId: updated.userId,
        status: updated.status,
        reason: updated.reason,
        dismissalReason: updated.dismissalReason,
        dismissedById: updated.dismissedById,
        dismissedAt: updated.dismissedAt,
        createdAt: updated.createdAt,
      },
      message: 'Structuring flag dismissed successfully',
    })
  } catch (error) {
    logger.error(
      { err: error },
      'POST /api/compliance/structuring-detection/[id]/dismiss error',
    )
    return NextResponse.json({ error: 'Failed to dismiss structuring flag' }, { status: 500 })
  }
}
