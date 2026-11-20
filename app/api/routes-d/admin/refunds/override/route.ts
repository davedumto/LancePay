import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import crypto from 'crypto'
import { AUDIT_SIGNING_SECRET } from '@/lib/audit'

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

    const body = await request.json().catch(() => ({}))
    const { invoiceId, amount, reason, notes } = body

    if (!invoiceId || typeof invoiceId !== 'string' || invoiceId.trim().length === 0) {
      return NextResponse.json({ error: 'invoiceId is required' }, { status: 400 })
    }

    const numericAmount = Number(amount)
    if (!amount || Number.isNaN(numericAmount) || numericAmount <= 0) {
      return NextResponse.json({ error: 'amount must be a positive number' }, { status: 400 })
    }

    if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
      return NextResponse.json({ error: 'reason is required' }, { status: 400 })
    }

    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } })
    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    if (numericAmount > Number(invoice.amount)) {
      return NextResponse.json(
        { error: 'Refund amount cannot exceed the invoice amount' },
        { status: 400 },
      )
    }

    const refundOverride = await prisma.refundOverride.create({
      data: {
        invoiceId,
        adminId: admin.id,
        amount: numericAmount,
        reason: reason.trim(),
        notes: notes ?? null,
      },
    })

    const metadataJson = JSON.stringify({ invoiceId, amount: numericAmount, reason, notes, adminEmail: admin.email })
    const signature = crypto
      .createHmac('sha256', AUDIT_SIGNING_SECRET)
      .update(metadataJson)
      .digest('hex')

    await prisma.auditEvent.create({
      data: {
        invoiceId,
        eventType: 'admin.refund.override',
        actorId: admin.id,
        metadata: { invoiceId, amount: numericAmount, reason, notes },
        signature,
      },
    })

    logger.info(
      { adminId: admin.id, invoiceId, refundOverrideId: refundOverride.id, amount: numericAmount },
      'Admin refund override created',
    )

    return NextResponse.json(
      {
        refundOverrideId: refundOverride.id,
        invoiceId,
        amount: refundOverride.amount,
        reason: refundOverride.reason,
        status: refundOverride.status,
        createdAt: refundOverride.createdAt,
      },
      { status: 201 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-d/admin/refunds/override error')
    return NextResponse.json({ error: 'Failed to create refund override' }, { status: 500 })
  }
}
