import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { verifySignature, maskSensitiveData } from '@/lib/audit'

export async function GET(request: NextRequest) {
  const invoiceId = request.nextUrl.searchParams.get('invoiceId')

  if (!invoiceId) {
    return NextResponse.json({ error: 'invoiceId is required' }, { status: 400 })
  }

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { userId: true },
  })

  if (!invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  }

  // Check if user is authenticated (owner)
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  let isOwner = false
  let userId: string | null = null

  if (authToken) {
    const claims = await verifyAuthToken(authToken)
    if (claims) {
      const user = await prisma.user.findUnique({
        where: { privyId: claims.userId },
        select: { id: true },
      })
      if (user) {
        userId = user.id
        isOwner = user.id === invoice.userId
      }
    }
  }

  // Only owner can view full audit stream
  if (!isOwner) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const events = await prisma.auditEvent.findMany({
    where: { invoiceId },
    orderBy: { createdAt: 'asc' },
    include: {
      actor: { select: { id: true, email: true, name: true } },
    },
  })

  const formattedEvents = events.map((event) => {
    const isValid = verifySignature(
      event.invoiceId,
      event.eventType,
      event.createdAt.toISOString(),
      event.metadata as Record<string, unknown> | null,
      event.signature
    )

    return {
      id: event.id,
      eventType: event.eventType,
      actor: event.actor
        ? { id: event.actor.id, email: event.actor.email, name: event.actor.name }
        : null,
      metadata: isOwner
        ? event.metadata
        : maskSensitiveData(event.metadata as Record<string, unknown> | null),
      signature: event.signature,
      isValid,
      createdAt: event.createdAt.toISOString(),
    }
  })

  return NextResponse.json({
    success: true,
    invoiceId,
    events: formattedEvents,
    totalEvents: events.length,
  })
}
