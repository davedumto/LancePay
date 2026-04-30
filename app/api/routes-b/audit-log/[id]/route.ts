import { withRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { parseAuditFilters } from '../../_lib/audit-filters'
import { getSeverity, buildSeverityFilter } from '../../_lib/audit-severity'

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

  const filters = parseAuditFilters(new URL(request.url).searchParams)

  if (!filters.ok) {
    return NextResponse.json({ error: filters.error }, { status: 400 })
  }

  const events = await prisma.auditEvent.findMany({
    where: {
      invoiceId: id,
      createdAt: {
        gte: filters.value.from,
        lte: filters.value.to,
      },
      ...buildSeverityFilter(new URL(request.url).searchParams.get('severity')),
      ...(filters.value.actor ? { actorId: filters.value.actor } : {}),
      invoice: {
        userId: user.id,
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  return NextResponse.json({
    events: events.map(event => ({
      id: event.id,
      action: event.eventType,
      resourceType: 'invoice',
      resourceId: event.invoiceId,
      ipAddress: null,
      userAgent: null,
      severity: getSeverity(event.eventType),
      createdAt: event.createdAt,
    })),
  })
}

export const GET = withRequestId(GETHandler)
