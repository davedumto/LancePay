import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { verifySignature, maskSensitiveData } from '@/lib/audit'
import { logger } from '@/lib/logger'

const INTERNAL_EVENT_PREFIXES = ['internal.', 'internal_', 'admin.']

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

function isInternalAuditEvent(event: {
  eventType: string
  metadata: unknown
}): boolean {
  const lowerType = event.eventType.toLowerCase()
  if (
    lowerType === 'internal' ||
    INTERNAL_EVENT_PREFIXES.some((prefix) => lowerType.startsWith(prefix))
  ) {
    return true
  }

  if (event.metadata && typeof event.metadata === 'object') {
    const meta = event.metadata as Record<string, unknown>
    if (meta.isInternal === true || meta.internal === true || meta.visibility === 'internal') {
      return true
    }
  }

  return false
}

/**
 * GET /api/invoices/[id]/audit-events
 * Fetches signed audit trail entries for an invoice ordered by createdAt ascending.
 * - Restricts access to the invoice owner and the paying client.
 * - Filters out internal events and masks sensitive metadata when viewed by the paying client.
 * - Verifies each entry's HMAC-SHA256 signature against its recorded fields and flags mismatches.
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
      },
    })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    const isOwner = invoice.userId === user.id
    const isClient =
      (Boolean(invoice.clientId) && invoice.clientId === user.id) ||
      (Boolean(user.email) &&
        Boolean(invoice.clientEmail) &&
        user.email.trim().toLowerCase() ===
          invoice.clientEmail.trim().toLowerCase())

    if (!isOwner && !isClient) {
      return NextResponse.json(
        {
          error:
            'Forbidden: Only the invoice owner or paying client may view invoice audit events',
        },
        { status: 403 },
      )
    }

    const { searchParams } = new URL(req.url)
    const verifyParam = searchParams.get('verify')
    const shouldVerify = verifyParam !== 'false'

    const rawEvents = await prisma.auditEvent.findMany({
      where: { invoiceId },
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

    const visibleEvents = isOwner
      ? rawEvents
      : rawEvents.filter((ev) => !isInternalAuditEvent(ev))

    let tamperedCount = 0

    const formattedEvents = visibleEvents.map((ev) => {
      const timestampIso =
        ev.createdAt instanceof Date
          ? ev.createdAt.toISOString()
          : new Date(ev.createdAt).toISOString()

      const rawMeta =
        ev.metadata && typeof ev.metadata === 'object'
          ? (ev.metadata as Record<string, unknown>)
          : null

      let signatureValid: boolean | null = null
      let tampered = false

      if (shouldVerify) {
        signatureValid = verifySignature(
          ev.invoiceId,
          ev.eventType,
          timestampIso,
          rawMeta,
          ev.signature,
        )
        tampered = !signatureValid
        if (tampered) tamperedCount++
      }

      return {
        id: ev.id,
        invoiceId: ev.invoiceId,
        eventType: ev.eventType,
        actorId: ev.actorId,
        metadata: maskSensitiveData(rawMeta, isOwner),
        signature: ev.signature,
        createdAt: ev.createdAt,
        signatureValid,
        tampered,
      }
    })

    return NextResponse.json({
      invoiceId: invoice.id,
      viewerRole: isOwner ? 'owner' : 'client',
      integrityVerified: shouldVerify ? tamperedCount === 0 : null,
      tamperedCount: shouldVerify ? tamperedCount : null,
      auditEvents: formattedEvents,
      events: formattedEvents,
      total: formattedEvents.length,
    })
  } catch (err) {
    logger?.error?.(
      { err },
      'GET /api/invoices/[id]/audit-events error',
    )
    return NextResponse.json(
      { error: 'Failed to fetch invoice audit events' },
      { status: 500 },
    )
  }
}
