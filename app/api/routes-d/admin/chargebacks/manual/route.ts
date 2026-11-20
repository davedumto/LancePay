import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import crypto from 'crypto'
import { isAdmin } from '@/lib/authorization'

const VALID_REASONS = [
  'fraud',
  'duplicate_charge',
  'goods_not_received',
  'service_not_rendered',
  'unauthorized_transaction',
  'admin_correction',
] as const

type ChargebackReason = (typeof VALID_REASONS)[number]

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const admin = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!admin) return NextResponse.json({ error: 'User not found' }, { status: 404 })
    if (!isAdmin(admin)) {
      return NextResponse.json({ error: 'Forbidden: admin access required' }, { status: 403 })
    }

    const body = await request.json().catch(() => ({}))
    const { invoiceId, reason, notes } = body

    if (!invoiceId || typeof invoiceId !== 'string' || invoiceId.trim().length === 0) {
      return NextResponse.json({ error: 'invoiceId is required' }, { status: 400 })
    }

    if (!reason || !VALID_REASONS.includes(reason as ChargebackReason)) {
      return NextResponse.json(
        { error: 'Invalid reason', validReasons: VALID_REASONS },
        { status: 400 },
      )
    }

    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } })
    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    const existing = await prisma.dispute.findUnique({ where: { invoiceId } })
    if (existing) {
      return NextResponse.json(
        { error: 'A dispute already exists for this invoice', disputeId: existing.id },
        { status: 409 },
      )
    }

    const dispute = await prisma.dispute.create({
      data: {
        invoiceId,
        initiatedBy: 'admin',
        initiatorEmail: admin.email,
        reason,
        requestedAction: notes ?? 'Admin-initiated chargeback',
        status: 'admin_initiated',
      },
    })

    const metadataJson = JSON.stringify({ invoiceId, reason, notes, adminEmail: admin.email })
    const signature = crypto
      .createHmac('sha256', process.env.AUDIT_SIGNING_SECRET ?? 'dev-secret')
      .update(metadataJson)
      .digest('hex')

    await prisma.auditEvent.create({
      data: {
        invoiceId,
        eventType: 'admin.chargeback.manual',
        actorId: admin.id,
        metadata: { invoiceId, reason, notes },
        signature,
      },
    })

    logger.info(
      { adminId: admin.id, invoiceId, disputeId: dispute.id, reason },
      'Manual admin chargeback initiated',
    )

    return NextResponse.json(
      {
        disputeId: dispute.id,
        invoiceId,
        reason,
        status: dispute.status,
        initiatedBy: admin.email,
        createdAt: dispute.createdAt,
      },
      { status: 201 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-d/admin/chargebacks/manual error')
    return NextResponse.json({ error: 'Failed to create manual chargeback' }, { status: 500 })
  }
}
