import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: invoiceId } = await params
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, userId: true, clientId: true },
    })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    // Restrict visibility to invoice owner and paying client only
    const isOwner = invoice.userId === user.id
    const isClient = invoice.clientId === user.id
    if (!isOwner && !isClient) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const events = await prisma.escrowEvent.findMany({
      where: { invoiceId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        invoiceId: true,
        eventType: true,
        actorType: true,
        actorEmail: true,
        notes: true,
        metadata: true,
        createdAt: true,
      },
    })

    return NextResponse.json({
      timeline: events.map((e) => ({
        ...e,
        createdAt: e.createdAt.toISOString(),
      })),
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/invoices/[id]/escrow-timeline error')
    return NextResponse.json({ error: 'Failed to fetch escrow timeline' }, { status: 500 })
  }
}
