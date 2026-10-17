import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

async function getAuthenticatedUser(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  const token = authHeader.slice(7).trim()
  if (!token) return null

  const claims = await verifyAuthToken(token)
  if (!claims) return null

  if (typeof prisma.user?.findUnique === 'function') {
    const dbUser = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true, email: true },
    })
    if (dbUser) return dbUser
  }

  return {
    id: claims.userId,
    email: claims.email ?? '',
  }
}

function canViewEscrowTimeline(
  user: { id: string; email: string },
  invoice: {
    userId: string
    clientId?: string | null
    clientEmail: string
  },
): boolean {
  if (invoice.userId === user.id) return true
  if (invoice.clientId && invoice.clientId === user.id) return true
  if (
    user.email &&
    invoice.clientEmail &&
    user.email.trim().toLowerCase() === invoice.clientEmail.trim().toLowerCase()
  ) {
    return true
  }
  return false
}

/**
 * GET /api/invoices/[id]/escrow-timeline
 * Reconstructs the chronological escrow event history for an invoice.
 * Visibility is strictly restricted to the invoice owner and the paying client.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } | Promise<{ id: string }> },
) {
  try {
    const user = await getAuthenticatedUser(req)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await Promise.resolve(params)
    const invoiceId = id?.trim()
    if (!invoiceId) {
      return NextResponse.json(
        { error: 'Invoice ID is required' },
        { status: 400 },
      )
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        userId: true,
        clientId: true,
        clientEmail: true,
        escrowEnabled: true,
        escrowStatus: true,
        escrowContractId: true,
        escrowReleasedAt: true,
        escrowDisputedAt: true,
      },
    })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    if (!canViewEscrowTimeline(user, invoice)) {
      return NextResponse.json(
        {
          error:
            'Forbidden: Only the invoice owner or paying client may view the escrow timeline',
        },
        { status: 403 },
      )
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
      invoiceId: invoice.id,
      escrowEnabled: invoice.escrowEnabled,
      escrowStatus: invoice.escrowStatus,
      escrowContractId: invoice.escrowContractId,
      escrowReleasedAt: invoice.escrowReleasedAt,
      escrowDisputedAt: invoice.escrowDisputedAt,
      timeline: events,
      events,
      total: events.length,
    })
  } catch (err) {
    logger?.error?.(
      { err },
      'GET /api/invoices/[id]/escrow-timeline error',
    )
    return NextResponse.json(
      { error: 'Failed to reconstruct invoice escrow timeline' },
      { status: 500 },
    )
  }
}
