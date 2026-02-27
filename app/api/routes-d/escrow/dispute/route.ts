import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { EscrowDisputeSchema, getAuthContext } from '@/app/api/routes-d/escrow/_shared'
import { sendEscrowDisputedEmail } from '@/lib/email'
import { logger } from '@/lib/logger'

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthContext(request)
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: 401 })

    const body = await request.json()
    const parsed = EscrowDisputeSchema.safeParse(body)
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid request' }, { status: 400 })

    const { invoiceId, clientEmail, reason, requestedAction } = parsed.data

    // Prevent spoofing
    if (clientEmail.toLowerCase() !== auth.email.toLowerCase()) {
      return NextResponse.json({ error: 'clientEmail must match authenticated user email' }, { status: 403 })
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { user: { select: { email: true } } },
    })
    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })

    if (invoice.clientEmail.toLowerCase() !== clientEmail.toLowerCase()) {
      return NextResponse.json({ error: 'Not authorized (client email mismatch)' }, { status: 403 })
    }

    if (!invoice.escrowEnabled) return NextResponse.json({ error: 'Escrow is not enabled for this invoice' }, { status: 400 })
    if (invoice.escrowStatus !== 'held') return NextResponse.json({ error: `Invalid escrow status: ${invoice.escrowStatus}` }, { status: 400 })

    const now = new Date()
    const updated = await prisma.$transaction(async (tx: any) => {
      const inv = await tx.invoice.update({
        where: { id: invoice.id },
        data: { escrowStatus: 'disputed', escrowDisputedAt: now },
        select: { id: true, escrowDisputedAt: true },
      })

      await tx.escrowEvent.create({
        data: {
          invoiceId: invoice.id,
          eventType: 'disputed',
          actorType: 'client',
          actorEmail: clientEmail,
          notes: reason,
          metadata: { requestedAction } as any,
        },
      })

      return inv
    })

    if (invoice.user.email) {
      await sendEscrowDisputedEmail({
        to: invoice.user.email,
        invoiceNumber: invoice.invoiceNumber,
        clientEmail,
        reason,
        requestedAction,
      })
    }

    return NextResponse.json({
      success: true,
      dispute: {
        invoiceId: updated.id,
        escrowStatus: 'disputed',
        reason,
        requestedAction,
        disputedAt: updated.escrowDisputedAt ? updated.escrowDisputedAt.toISOString() : now.toISOString(),
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'Escrow dispute error:')
    return NextResponse.json({ error: 'Failed to dispute escrow' }, { status: 500 })
  }
}

