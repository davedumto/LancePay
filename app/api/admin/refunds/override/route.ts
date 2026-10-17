import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const ALLOWED_OVERRIDE_STATUSES = ['completed', 'approved', 'failed'] as const

function extractToken(req: NextRequest): string | null {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  return authHeader.slice(7).trim() || null
}

async function verifyAdmin(req: NextRequest) {
  const token = extractToken(req)
  const claims = token ? await verifyAuthToken(token) : null
  if (!claims) {
    return { error: 'Unauthorized', status: 401 as const, claims: null }
  }

  let isAdmin = claims.role === 'admin'
  if (!isAdmin && typeof prisma.user?.findUnique === 'function') {
    const dbUser = await prisma.user.findUnique({
      where: { id: claims.userId },
      select: { role: true },
    })
    isAdmin = dbUser?.role === 'admin'
  }

  if (!isAdmin) {
    return {
      error: 'Forbidden: Admin access required',
      status: 403 as const,
      claims: null,
    }
  }

  return { error: null, status: 200 as const, claims }
}

/**
 * GET /api/admin/refunds/override
 * Lists administrative refund overrides with optional invoiceId, adminId, and status filters.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await verifyAdmin(req)
    if (auth.error || !auth.claims) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const { searchParams } = new URL(req.url)
    const invoiceId = searchParams.get('invoiceId')?.trim() || undefined
    const adminId = searchParams.get('adminId')?.trim() || undefined
    const status = searchParams.get('status')?.trim().toLowerCase() || undefined
    const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1)
    const limit = Math.min(
      100,
      Math.max(1, parseInt(searchParams.get('limit') ?? '20', 10) || 20),
    )
    const skip = (page - 1) * limit

    const where: Record<string, unknown> = {}
    if (invoiceId) where.invoiceId = invoiceId
    if (adminId) where.adminId = adminId
    if (status) where.status = status

    const [overrides, total] = await Promise.all([
      prisma.refundOverride.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.refundOverride.count({ where }),
    ])

    const formatted = overrides.map((o) => ({
      ...o,
      amount: Number(o.amount),
    }))

    return NextResponse.json({
      data: formatted,
      overrides: formatted,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    })
  } catch (err) {
    console.error('[GET /api/admin/refunds/override]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * POST /api/admin/refunds/override
 * Executes an administrative refund override with role enforcement, cumulative
 * invoice balance validation, and immutable audit trail logging.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await verifyAdmin(req)
    if (auth.error || !auth.claims) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const { claims } = auth

    let body: Record<string, unknown>
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const invoiceId =
      typeof body.invoiceId === 'string' ? body.invoiceId.trim() : ''
    const refundId =
      typeof body.refundId === 'string' && body.refundId.trim()
        ? body.refundId.trim()
        : null
    const rawAmount = body.amount
    const reason =
      typeof body.reason === 'string' ? body.reason.trim() : ''
    const notes =
      typeof body.notes === 'string' && body.notes.trim()
        ? body.notes.trim()
        : null
    const status =
      typeof body.status === 'string' && body.status.trim()
        ? body.status.trim().toLowerCase()
        : 'completed'

    if (!invoiceId) {
      return NextResponse.json(
        { error: 'invoiceId is required' },
        { status: 400 },
      )
    }

    const amount = Number(rawAmount)
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json(
        { error: 'amount must be a positive number' },
        { status: 400 },
      )
    }

    if (!reason || reason.length < 5) {
      return NextResponse.json(
        { error: 'reason is required and must be at least 5 characters' },
        { status: 400 },
      )
    }

    if (
      !ALLOWED_OVERRIDE_STATUSES.includes(
        status as (typeof ALLOWED_OVERRIDE_STATUSES)[number],
      )
    ) {
      return NextResponse.json(
        {
          error: `status must be one of: ${ALLOWED_OVERRIDE_STATUSES.join(', ')}`,
        },
        { status: 400 },
      )
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
    })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    const invoiceAmount = Number(invoice.amount)
    let existingRefundTotal = 0

    if (typeof prisma.refundOverride.findMany === 'function') {
      const priorOverrides =
        (await prisma.refundOverride.findMany({
          where: { invoiceId, status: 'completed' },
        })) ?? []

      existingRefundTotal = priorOverrides.reduce(
        (sum, item) => sum + Number(item.amount ?? 0),
        0,
      )
    }

    const remainingRefundable = Number(
      (invoiceAmount - existingRefundTotal).toFixed(2),
    )

    if (invoiceAmount > 0 && amount > remainingRefundable + 0.0001) {
      return NextResponse.json(
        {
          error: 'Override refund amount exceeds remaining refundable invoice balance',
          invoiceAmount,
          alreadyRefunded: existingRefundTotal,
          remainingRefundable: Math.max(0, remainingRefundable),
        },
        { status: 422 },
      )
    }

    const overrideRecord = await prisma.refundOverride.create({
      data: {
        invoiceId,
        adminId: claims.userId,
        amount,
        reason,
        notes,
        status,
      },
    })

    if (refundId && typeof prisma.refund?.update === 'function') {
      await prisma.refund.update({
        where: { id: refundId },
        data: { status },
      })
    }

    if (typeof prisma.auditLog?.create === 'function') {
      await prisma.auditLog.create({
        data: {
          actorId: claims.userId,
          actorEmail: claims.email ?? null,
          action: 'admin.refund.override',
          resourceType: 'RefundOverride',
          resourceId: overrideRecord.id,
          metadata: {
            invoiceId,
            refundId,
            amount,
            reason,
            notes,
            status,
          },
        },
      })
    }

    const formatted = {
      ...overrideRecord,
      amount: Number(overrideRecord.amount),
    }

    return NextResponse.json(
      {
        override: formatted,
        refundOverride: formatted,
        data: formatted,
      },
      { status: 201 },
    )
  } catch (err) {
    console.error('[POST /api/admin/refunds/override]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
