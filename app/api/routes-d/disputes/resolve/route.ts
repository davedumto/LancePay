import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import {
  DisputeResolveSchema,
  getAuthContext,
  isAdminEmail,
} from '@/app/api/routes-d/disputes/_shared'
import { sendDisputeResolvedEmail } from '@/lib/email'
import { updateUserTrustScore } from '@/lib/reputation'

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthContext(request)
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: 401 })

    const body = await request.json()
    const parsed = DisputeResolveSchema.safeParse(body)
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid request' }, { status: 400 })

    const { disputeId, resolution, action, refundAmount, resolvedBy } = parsed.data

    const dispute = await prisma.dispute.findUnique({
      where: { id: disputeId },
      include: { invoice: { include: { user: { select: { id: true, email: true } } } } },
    })
    if (!dispute) return NextResponse.json({ error: 'Dispute not found' }, { status: 404 })
    if (dispute.status === 'resolved' || dispute.status === 'closed') {
      return NextResponse.json({ error: 'Dispute already resolved' }, { status: 400 })
    }

    const admin = isAdminEmail(auth.email)
    const isFreelancer = auth.user.id === dispute.invoice.userId
    const isClient = auth.email.toLowerCase() === dispute.invoice.clientEmail.toLowerCase()

    if (resolvedBy === 'admin' && !admin) {
      return NextResponse.json({ error: 'Admin privileges required' }, { status: 403 })
    }
    if (resolvedBy === 'mutual_agreement' && !(isClient || isFreelancer)) {
      return NextResponse.json({ error: 'Not authorized to resolve this dispute' }, { status: 403 })
    }

    if (action === 'refund_partial') {
      if (!refundAmount || Number.isNaN(refundAmount)) {
        return NextResponse.json({ error: 'refundAmount is required for refund_partial' }, { status: 400 })
      }
      const invAmount = Number(dispute.invoice.amount)
      if (refundAmount <= 0 || refundAmount >= invAmount) {
        return NextResponse.json({ error: 'refundAmount must be > 0 and < invoice amount' }, { status: 400 })
      }
    }

    const invAmount = Number(dispute.invoice.amount)
    const computedRefund =
      action === 'refund_full' ? invAmount : action === 'refund_partial' ? refundAmount! : 0

    const updated = await prisma.$transaction(async (tx) => {
      const now = new Date()

      const disputeUpdated = await tx.dispute.update({
        where: { id: dispute.id },
        data: {
          status: 'resolved',
          resolution,
          resolvedBy,
          resolvedAt: now,
          updatedAt: now,
        },
        select: { id: true, status: true, resolution: true, resolvedAt: true },
      })

      // Refund ledger entry (no external provider integration in this repo yet)
      if (computedRefund > 0) {
        await tx.transaction.create({
          data: {
            userId: dispute.invoice.userId,
            type: 'refund',
            status: 'completed',
            amount: computedRefund,
            currency: dispute.invoice.currency,
            completedAt: now,
          },
        })
      }

      // Invoice status transitions
      let invoiceStatus = dispute.invoice.status
      if (action === 'no_refund') invoiceStatus = 'paid'
      if (action === 'refund_full') invoiceStatus = 'refunded'
      if (action === 'refund_partial') invoiceStatus = 'partially_refunded'

      await tx.invoice.update({
        where: { id: dispute.invoice.id },
        data: { status: invoiceStatus },
      })

      await tx.disputeMessage.create({
        data: {
          disputeId: dispute.id,
          senderType: resolvedBy === 'admin' ? 'admin' : (isClient ? 'client' : 'freelancer'),
          senderEmail: auth.email,
          message: `Resolution: ${resolution}\n\nAction: ${action}${action === 'refund_partial' ? ` (${computedRefund} ${dispute.invoice.currency})` : ''}`,
          attachments: undefined,
        },
      })

      return disputeUpdated
    })

    const notifyTargets = [dispute.invoice.clientEmail, dispute.invoice.user.email].filter(Boolean)
    for (const to of notifyTargets) {
      await sendDisputeResolvedEmail({
        to,
        invoiceNumber: dispute.invoice.invoiceNumber,
        resolution,
        action,
        refundAmount: action === 'refund_partial' ? computedRefund : undefined,
        currency: dispute.invoice.currency,
      })
    }

    // Update trust score if freelancer lost the dispute (refund_full or refund_partial)
    if (action === 'refund_full' || action === 'refund_partial') {
      try {
        await updateUserTrustScore(dispute.invoice.userId)
      } catch (error) {
        console.error('Failed to update trust score after dispute resolution:', error)
        // Don't fail the dispute resolution if score update fails
      }
    }

    return NextResponse.json({
      success: true,
      dispute: {
        id: updated.id,
        status: 'resolved',
        resolution: updated.resolution,
        resolvedAt: updated.resolvedAt ? updated.resolvedAt.toISOString() : new Date().toISOString(),
      },
    })
  } catch (error) {
    console.error('Dispute resolve error:', error)
    return NextResponse.json({ error: 'Failed to resolve dispute' }, { status: 500 })
  }
}

