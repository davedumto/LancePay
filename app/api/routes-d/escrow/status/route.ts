import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAuthContext } from '@/app/api/routes-d/escrow/_shared'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthContext(request)
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: 401 })

    const invoiceId = request.nextUrl.searchParams.get('invoiceId')
    if (!invoiceId) return NextResponse.json({ error: 'invoiceId is required' }, { status: 400 })

    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        escrowEvents: { orderBy: { createdAt: 'asc' } },
      },
    })
    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })

    const isFreelancer = invoice.userId === auth.user.id
    const isClient = invoice.clientEmail.toLowerCase() === auth.email.toLowerCase()
    if (!isFreelancer && !isClient) return NextResponse.json({ error: 'Not authorized' }, { status: 403 })

    return NextResponse.json({
      invoice: {
        id: invoice.id,
        escrowEnabled: (invoice as any).escrowEnabled,
        escrowStatus: (invoice as any).escrowStatus,
        escrowContractId: (invoice as any).escrowContractId,
        releaseConditions: (invoice as any).escrowReleaseConditions || '',
        escrowReleasedAt: (invoice as any).escrowReleasedAt ? (invoice as any).escrowReleasedAt.toISOString() : undefined,
        escrowDisputedAt: (invoice as any).escrowDisputedAt ? (invoice as any).escrowDisputedAt.toISOString() : undefined,
      },
      events: ((invoice as any).escrowEvents || []).map((e: any) => ({
        id: e.id,
        eventType: e.eventType,
        actorType: e.actorType,
        actorEmail: e.actorEmail,
        notes: e.notes || '',
        createdAt: e.createdAt.toISOString(),
      })),
    })
  } catch (error) {
    logger.error({ err: error }, 'Escrow status error:')
    return NextResponse.json({ error: 'Failed to get escrow status' }, { status: 500 })
  }
}

