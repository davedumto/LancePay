import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import {
  DisputeRespondSchema,
  getAuthContext,
  isAdminEmail,
  senderTypeForDispute,
} from '@/app/api/routes-d/disputes/_shared'
import { sendDisputeMessageEmail } from '@/lib/email'
import { logger } from '@/lib/logger'

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthContext(request)
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: 401 })

    const body = await request.json()
    const parsed = DisputeRespondSchema.safeParse(body)
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid request' }, { status: 400 })

    const { disputeId, senderEmail, message, attachments } = parsed.data

    // Prevent spoofing
    if (senderEmail.toLowerCase() !== auth.email.toLowerCase()) {
      return NextResponse.json({ error: 'senderEmail must match authenticated user email' }, { status: 403 })
    }

    const dispute = await prisma.dispute.findUnique({
      where: { id: disputeId },
      include: { invoice: { include: { user: { select: { id: true, email: true } } } } },
    })
    if (!dispute) return NextResponse.json({ error: 'Dispute not found' }, { status: 404 })
    if (dispute.status === 'resolved' || dispute.status === 'closed') {
      return NextResponse.json({ error: 'Dispute is not accepting new messages' }, { status: 400 })
    }

    const admin = isAdminEmail(auth.email)
    const isFreelancer = auth.user.id === dispute.invoice.userId
    const isClient = senderEmail.toLowerCase() === dispute.invoice.clientEmail.toLowerCase()

    const senderType = senderTypeForDispute({ isAdmin: admin, isFreelancer, isClient })
    if (!senderType) return NextResponse.json({ error: 'Not authorized to respond to this dispute' }, { status: 403 })

    const created = await prisma.$transaction(async (tx: any) => {
      const msg = await tx.disputeMessage.create({
        data: {
          disputeId: dispute.id,
          senderType,
          senderEmail,
          message,
          attachments: attachments ?? undefined,
        },
        select: { id: true, disputeId: true, senderType: true, message: true, createdAt: true },
      })

      await tx.dispute.update({ where: { id: dispute.id }, data: { updatedAt: new Date() } })
      return msg
    })

    const otherPartyEmail =
      senderType === 'client'
        ? dispute.invoice.user.email
        : senderType === 'freelancer'
          ? dispute.invoice.clientEmail
          : null

    if (otherPartyEmail) {
      await sendDisputeMessageEmail({
        to: otherPartyEmail,
        invoiceNumber: dispute.invoice.invoiceNumber,
        senderType,
        message,
      })
    }

    return NextResponse.json({
      success: true,
      message: {
        id: created.id,
        disputeId: created.disputeId,
        senderType: created.senderType,
        message: created.message,
        createdAt: created.createdAt.toISOString(),
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'Dispute respond error:')
    return NextResponse.json({ error: 'Failed to add dispute message' }, { status: 500 })
  }
}

