import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import crypto from 'crypto'

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })
    if (user.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden: admin access required' }, { status: 403 })
    }

    const { searchParams } = new URL(request.url)
    const invoiceId = searchParams.get('invoiceId')

    const where: any = {}
    if (invoiceId) where.invoiceId = invoiceId

    const overrides = await prisma.refundOverride.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        admin: {
          select: { id: true, email: true, name: true },
        },
      },
    })

    return NextResponse.json({
      refundOverrides: overrides.map((o) => ({
        ...o,
        amount: o.amount.toString(),
        createdAt: o.createdAt.toISOString(),
      })),
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/admin/refunds/override error')
    return NextResponse.json({ error: 'Failed to fetch refund overrides' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const admin = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!admin) return NextResponse.json({ error: 'User not found' }, { status: 404 })
    if (admin.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden: admin access required' }, { status: 403 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { invoiceId, amount, reason, notes } = (body ?? {}) as {
      invoiceId?: string
      amount?: number | string
      reason?: string
      notes?: string
    }

    if (!invoiceId || typeof invoiceId !== 'string' || !invoiceId.trim()) {
      return NextResponse.json({ error: 'invoiceId is required' }, { status: 400 })
    }

    const numericAmount = Number(amount)
    if (!amount || Number.isNaN(numericAmount) || numericAmount <= 0) {
      return NextResponse.json({ error: 'amount must be a positive number' }, { status: 400 })
    }

    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      return NextResponse.json({ error: 'reason is required' }, { status: 400 })
    }

    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } })
    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    const refundOverride = await prisma.refundOverride.create({
      data: {
        invoiceId,
        adminId: admin.id,
        amount: numericAmount,
        reason: reason.trim(),
        notes: typeof notes === 'string' && notes.trim() ? notes.trim() : null,
      },
    })

    const metadataJson = JSON.stringify({
      invoiceId,
      amount: numericAmount,
      reason: reason.trim(),
      notes: notes ?? null,
      adminEmail: admin.email,
    })
    const signature = crypto
      .createHmac('sha256', process.env.AUDIT_SIGNING_SECRET ?? 'dev-secret')
      .update(metadataJson)
      .digest('hex')

    await prisma.auditEvent.create({
      data: {
        invoiceId,
        eventType: 'admin.refund.override',
        actorId: admin.id,
        metadata: { invoiceId, amount: numericAmount, reason: reason.trim(), notes },
        signature,
      },
    })

    logger.info(
      { adminId: admin.id, invoiceId, refundOverrideId: refundOverride.id, amount: numericAmount },
      'Admin refund override created',
    )

    return NextResponse.json(
      {
        refundOverride: {
          ...refundOverride,
          amount: refundOverride.amount.toString(),
          createdAt: refundOverride.createdAt.toISOString(),
        },
      },
      { status: 201 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/admin/refunds/override error')
    return NextResponse.json({ error: 'Failed to create refund override' }, { status: 500 })
  }
}
