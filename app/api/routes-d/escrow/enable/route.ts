import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { EscrowEnableSchema, getAuthContext } from '@/app/api/routes-d/escrow/_shared'

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthContext(request)
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: 401 })

    const body = await request.json()
    const parsed = EscrowEnableSchema.safeParse(body)
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid request' }, { status: 400 })

    const { invoiceId, releaseConditions } = parsed.data

    const invoice = (await prisma.invoice.findUnique({ where: { id: invoiceId } })) as any
    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })

    // Only freelancer (invoice owner) can enable escrow.
    if (invoice.userId !== auth.user.id) return NextResponse.json({ error: 'Not authorized' }, { status: 403 })

    // Must be unpaid.
    if (invoice.status !== 'pending') return NextResponse.json({ error: 'Escrow can only be enabled on unpaid invoices' }, { status: 400 })

    const updated = await prisma.$transaction(async (tx) => {
      const inv = await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          escrowEnabled: true,
          escrowStatus: 'none',
          escrowReleaseConditions: releaseConditions ?? invoice.escrowReleaseConditions ?? null,
        },
        select: { id: true, escrowEnabled: true, escrowStatus: true, escrowReleaseConditions: true },
      })

      await (tx as any).escrowEvent.create({
        data: {
          invoiceId: invoice.id,
          eventType: 'created',
          actorType: 'freelancer',
          actorEmail: auth.email,
          notes: 'Escrow enabled on invoice',
          metadata: { releaseConditions: releaseConditions ?? null },
        },
      })

      return inv
    })

    return NextResponse.json({
      success: true,
      invoice: {
        id: updated.id,
        escrowEnabled: updated.escrowEnabled,
        escrowStatus: updated.escrowStatus,
        releaseConditions: updated.escrowReleaseConditions || '',
      },
    })
  } catch (error) {
    console.error('Escrow enable error:', error)
    return NextResponse.json({ error: 'Failed to enable escrow' }, { status: 500 })
  }
}

