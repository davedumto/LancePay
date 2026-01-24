import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { EscrowReleaseSchema, getAuthContext } from '@/app/api/routes-d/escrow/_shared'
import { sendEscrowReleasedEmail } from '@/lib/email'

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthContext(request)
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: 401 })

    const body = await request.json()
    const parsed = EscrowReleaseSchema.safeParse(body)
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid request' }, { status: 400 })

    const { invoiceId, clientEmail, approvalNotes } = parsed.data

    // Prevent spoofing
    if (clientEmail.toLowerCase() !== auth.email.toLowerCase()) {
      return NextResponse.json({ error: 'clientEmail must match authenticated user email' }, { status: 403 })
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { user: { select: { email: true, name: true } } },
    }) as any
    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })

    if (invoice.clientEmail.toLowerCase() !== clientEmail.toLowerCase()) {
      return NextResponse.json({ error: 'Not authorized (client email mismatch)' }, { status: 403 })
    }

    if (!invoice.escrowEnabled) return NextResponse.json({ error: 'Escrow is not enabled for this invoice' }, { status: 400 })
    if (invoice.escrowStatus !== 'held') return NextResponse.json({ error: `Invalid escrow status: ${invoice.escrowStatus}` }, { status: 400 })

    const now = new Date()
    const updated = await prisma.$transaction(async (tx) => {
      const inv = await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          escrowStatus: 'released',
          escrowReleasedAt: now,
        },
        select: { id: true, escrowStatus: true, escrowReleasedAt: true },
      })

      await (tx as any).escrowEvent.create({
        data: {
          invoiceId: invoice.id,
          eventType: 'released',
          actorType: 'client',
          actorEmail: clientEmail,
          notes: approvalNotes || 'Client approved work and released escrow',
        },
      })

      return inv
    })

    if (invoice.user.email) {
      await sendEscrowReleasedEmail({
        to: invoice.user.email,
        invoiceNumber: invoice.invoiceNumber,
        clientEmail,
        notes: approvalNotes,
      })
    }

    return NextResponse.json({
      success: true,
      message: 'Escrow released to freelancer',
      invoice: {
        id: updated.id,
        escrowStatus: 'released',
        escrowReleasedAt: updated.escrowReleasedAt ? updated.escrowReleasedAt.toISOString() : now.toISOString(),
      },
    })
  } catch (error) {
    console.error('Escrow release error:', error)
    return NextResponse.json({ error: 'Failed to release escrow' }, { status: 500 })
  }
}

