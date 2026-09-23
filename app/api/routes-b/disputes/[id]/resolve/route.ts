import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import crypto from 'crypto'

// POST /api/routes-b/disputes/[id]/resolve
// Resolve a dispute and apply the corresponding financial adjustment to the
// ledger. Restricted to admin and arbitrator roles.

const OUTCOMES = ['full-refund', 'partial-refund', 'no-refund'] as const
type Outcome = (typeof OUTCOMES)[number]

const FAVORED_PARTIES = ['client', 'freelancer'] as const
type FavoredParty = (typeof FAVORED_PARTIES)[number]

const RESOLVER_ROLES = ['admin', 'arbitrator']

const INVOICE_STATUS_BY_OUTCOME: Record<Outcome, string | null> = {
  'full-refund': 'refunded',
  'partial-refund': 'partially_refunded',
  'no-refund': null,
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } | Promise<{ id: string }> },
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const actor = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true, role: true, email: true },
    })
    if (!actor) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }
    if (!RESOLVER_ROLES.includes(actor.role)) {
      return NextResponse.json(
        { error: 'Forbidden: admin or arbitrator role required' },
        { status: 403 },
      )
    }

    const { id: disputeId } = await Promise.resolve(params)
    if (!disputeId || !disputeId.trim()) {
      return NextResponse.json({ error: 'Dispute ID is required' }, { status: 400 })
    }

    const dispute = await prisma.dispute.findUnique({
      where: { id: disputeId },
      select: {
        id: true,
        status: true,
        resolution: true,
        resolvedBy: true,
        resolvedAt: true,
        invoiceId: true,
        invoice: { select: { id: true, userId: true, amount: true, currency: true } },
      },
    })
    if (!dispute) {
      return NextResponse.json({ error: 'Dispute not found' }, { status: 404 })
    }

    // Idempotent: resolving an already-resolved dispute returns the recorded
    // outcome instead of erroring or applying a second adjustment.
    if (dispute.status === 'resolved' || dispute.status === 'closed') {
      let existing: unknown = dispute.resolution
      try {
        existing = dispute.resolution ? JSON.parse(dispute.resolution) : null
      } catch {
        existing = dispute.resolution
      }
      return NextResponse.json({
        alreadyResolved: true,
        disputeId: dispute.id,
        status: dispute.status,
        resolution: existing,
        resolvedBy: dispute.resolvedBy,
        resolvedAt: dispute.resolvedAt,
      })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const payload = (body ?? {}) as {
      outcome?: unknown
      favoredParty?: unknown
      amount?: unknown
      reason?: unknown
    }

    if (typeof payload.outcome !== 'string' || !OUTCOMES.includes(payload.outcome as Outcome)) {
      return NextResponse.json(
        { error: `outcome must be one of: ${OUTCOMES.join(', ')}` },
        { status: 400 },
      )
    }
    const outcome = payload.outcome as Outcome

    if (
      typeof payload.favoredParty !== 'string' ||
      !FAVORED_PARTIES.includes(payload.favoredParty as FavoredParty)
    ) {
      return NextResponse.json(
        { error: `favoredParty must be one of: ${FAVORED_PARTIES.join(', ')}` },
        { status: 400 },
      )
    }
    const favoredParty = payload.favoredParty as FavoredParty

    const reason =
      typeof payload.reason === 'string' && payload.reason.trim()
        ? payload.reason.trim()
        : 'Dispute resolution'

    const invoiceAmount = Number(dispute.invoice.amount)
    let refundAmount = 0
    if (outcome === 'full-refund') {
      refundAmount = invoiceAmount
    } else if (outcome === 'partial-refund') {
      refundAmount = Number(payload.amount)
      if (!Number.isFinite(refundAmount) || refundAmount <= 0 || refundAmount >= invoiceAmount) {
        return NextResponse.json(
          { error: 'amount must be greater than 0 and less than the invoice amount for a partial refund' },
          { status: 400 },
        )
      }
    }

    const resolutionRecord = JSON.stringify({ outcome, favoredParty, amount: refundAmount })
    const resolvedAt = new Date()

    const outcomeResult = await prisma.$transaction(async (tx) => {
      let refundId: string | null = null

      // Apply the financial adjustment to the ledger for refund outcomes.
      if (refundAmount > 0) {
        const refund = await tx.refund.create({
          data: {
            userId: dispute.invoice.userId,
            invoiceId: dispute.invoice.id,
            amount: refundAmount,
            currency: dispute.invoice.currency,
            reason,
            status: 'completed',
          },
        })
        refundId = refund.id

        await tx.transaction.create({
          data: {
            userId: dispute.invoice.userId,
            type: 'refund',
            status: 'completed',
            amount: refundAmount,
            currency: dispute.invoice.currency,
            completedAt: resolvedAt,
          },
        })

        const nextStatus = INVOICE_STATUS_BY_OUTCOME[outcome]
        if (nextStatus) {
          await tx.invoice.update({
            where: { id: dispute.invoice.id },
            data: { status: nextStatus },
          })
        }
      }

      await tx.dispute.update({
        where: { id: dispute.id },
        data: {
          status: 'resolved',
          resolution: resolutionRecord,
          resolvedBy: actor.id,
          resolvedAt,
        },
      })

      const metadataJson = JSON.stringify({
        disputeId: dispute.id,
        invoiceId: dispute.invoice.id,
        outcome,
        favoredParty,
        amount: refundAmount,
        arbiterEmail: actor.email,
      })
      const signature = crypto
        .createHmac('sha256', process.env.AUDIT_SIGNING_SECRET ?? 'dev-secret')
        .update(metadataJson)
        .digest('hex')

      await tx.auditEvent.create({
        data: {
          invoiceId: dispute.invoice.id,
          eventType: 'dispute.resolved',
          actorId: actor.id,
          metadata: { disputeId: dispute.id, outcome, favoredParty, amount: refundAmount },
          signature,
        },
      })

      return { refundId }
    })

    logger.info(
      { actorId: actor.id, disputeId: dispute.id, outcome, favoredParty, amount: refundAmount },
      'POST /api/routes-b/disputes/[id]/resolve',
    )

    return NextResponse.json({
      disputeId: dispute.id,
      status: 'resolved',
      outcome,
      favoredParty,
      amount: refundAmount,
      refundId: outcomeResult.refundId,
      resolvedBy: actor.id,
      resolvedAt,
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-b/disputes/[id]/resolve error')
    return NextResponse.json({ error: 'Failed to resolve dispute' }, { status: 500 })
  }
}
