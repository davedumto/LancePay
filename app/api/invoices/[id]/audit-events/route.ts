import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import crypto from 'crypto'

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

    const isOwner = invoice.userId === user.id
    const isClient = invoice.clientId === user.id

    if (!isOwner && !isClient) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const where: any = { invoiceId }
    // If user is client and not owner, restrict visibility to non-internal events
    if (isClient && !isOwner) {
      where.eventType = {
        not: {
          startsWith: 'internal.',
        },
      }
    }

    const events = await prisma.auditEvent.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        invoiceId: true,
        eventType: true,
        actorId: true,
        metadata: true,
        signature: true,
        createdAt: true,
      },
    })

    const auditSigningSecret = process.env.AUDIT_SIGNING_SECRET ?? 'dev-secret'

    const verifiedEvents = events.map((event) => {
      let isSignatureValid = false
      if (event.signature && event.metadata) {
        try {
          const expectedSig = crypto
            .createHmac('sha256', auditSigningSecret)
            .update(JSON.stringify(event.metadata))
            .digest('hex')
          isSignatureValid = expectedSig === event.signature
        } catch {
          isSignatureValid = false
        }
      }

      return {
        ...event,
        createdAt: event.createdAt.toISOString(),
        verified: isSignatureValid,
      }
    })

    return NextResponse.json({ events: verifiedEvents })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/invoices/[id]/audit-events error')
    return NextResponse.json({ error: 'Failed to fetch audit events' }, { status: 500 })
  }
}
