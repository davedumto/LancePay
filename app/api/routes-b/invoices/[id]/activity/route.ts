import { withRequestId } from '../../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

// The AuditEvent model stores `ipAddress` (when known) inside the `metadata`
// JSON column rather than as a dedicated field, so we surface it from there.
function extractIpAddress(metadata: unknown): string | null {
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const value = (metadata as Record<string, unknown>).ipAddress
    return typeof value === 'string' && value.length > 0 ? value : null
  }
  return null
}

async function GETHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const invoice = await prisma.invoice.findUnique({
    where: { id },
    select: { id: true, userId: true },
  })

  if (!invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  }

  if (invoice.userId !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const events = await prisma.auditEvent.findMany({
    where: { invoiceId: invoice.id },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      eventType: true,
      metadata: true,
      createdAt: true,
    },
  })

  return NextResponse.json({
    activity: events.map((event) => ({
      id: event.id,
      action: event.eventType,
      ipAddress: extractIpAddress(event.metadata),
      createdAt: event.createdAt,
    })),
  })
}

export const GET = withRequestId(GETHandler)
