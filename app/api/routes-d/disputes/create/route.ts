import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import {
  DisputeCreateSchema,
  getAuthContext,
  type DisputeParty,
} from '@/app/api/routes-d/disputes/_shared'
import { sendDisputeInitiatedEmail } from '@/lib/email'
import { logger } from '@/lib/logger'

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthContext(request)
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: 401 })

    const body = await request.json()
    const parsed = DisputeCreateSchema.safeParse(body)
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid request' }, { status: 400 })

    const { invoiceId, reason, requestedAction, evidence } = parsed.data
    const initiatorEmail = auth.email

    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { user: { select: { id: true, email: true, name: true } } },
    })
    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })

    if (invoice.status !== 'paid') {
      return NextResponse.json(
        { error: 'Only paid transactions are eligible for dispute resolution' },
        { status: 400 }
      )
    }

    const isFreelancer = auth.user.id === invoice.userId
    const isClient = initiatorEmail.toLowerCase() === invoice.clientEmail.toLowerCase()

    if (!isFreelancer && !isClient) {
      return NextResponse.json({ error: 'Not authorized to dispute this invoice' }, { status: 403 })
    }

    const initiatedBy: DisputeParty = isClient ? 'client' : 'freelancer'

    const existing = await prisma.dispute.findUnique({ where: { invoiceId: invoice.id } })
    if (existing) return NextResponse.json({ error: 'A dispute already exists for this invoice' }, { status: 409 })

    const created = await prisma.$transaction(async (tx: any) => {
      const dispute = await tx.dispute.create({
        data: {
          invoiceId: invoice.id,
          initiatedBy,
          initiatorEmail,
          reason,
          requestedAction,
          status: 'open',
        },
        select: { id: true, invoiceId: true, status: true, initiatedBy: true, reason: true, createdAt: true },
      })

      await tx.invoice.update({
        where: { id: invoice.id },
        data: { status: 'disputed' },
      })

      await tx.disputeMessage.create({
        data: {
          disputeId: dispute.id,
          senderType: initiatedBy,
          senderEmail: initiatorEmail,
          message: reason,
          attachments: evidence ?? undefined,
        },
      })

      if (invoice.escrowEnabled) {
        await tx.escrowEvent.create({
          data: {
            invoiceId: invoice.id,
            eventType: 'disputed',
            actorType: initiatedBy,
            actorEmail: initiatorEmail,
            notes: `Dispute opened: ${reason}`,
          },
        })
      }

      return dispute
    })

    const otherPartyEmail =
      initiatedBy === 'client' ? invoice.user.email : invoice.clientEmail

    if (otherPartyEmail) {
      await sendDisputeInitiatedEmail({
        to: otherPartyEmail,
        invoiceNumber: invoice.invoiceNumber,
        initiatedBy,
        reason,
        requestedAction,
      })
    }

    return NextResponse.json({
      success: true,
      dispute: {
        id: created.id,
        invoiceId: created.invoiceId,
        status: 'open',
        initiatedBy: created.initiatedBy,
        reason: created.reason,
        createdAt: created.createdAt.toISOString(),
      },
    })
  } catch (error: any) {
    // Unique constraint protection for concurrent requests
    if (error?.code === 'P2002') {
      return NextResponse.json({ error: 'A dispute already exists for this invoice' }, { status: 409 })
    }
    logger.error({ err: error }, 'Dispute create error:')
    return NextResponse.json({ error: 'Failed to create dispute' }, { status: 500 })
  }
}

