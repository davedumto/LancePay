import { withRequestId } from '../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { buildActionFilter } from '../_lib/audit-action-filter' // Issue #621
import { getSeverity, buildSeverityFilter } from '../_lib/audit-severity'

async function GETHandler(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const { searchParams } = new URL(request.url)

  const parsedPage = parseInt(searchParams.get('page') || '1', 10)
  const page = Number.isNaN(parsedPage) || parsedPage < 1 ? 1 : parsedPage

  const parsedLimit = parseInt(searchParams.get('limit') || '20', 10)
  const limit = Math.min(50, Math.max(1, Number.isNaN(parsedLimit) ? 20 : parsedLimit))

  // Issue #621 — exact-match (?action) and prefix-match (?actionPrefix) filters
  const actionFilter = buildActionFilter(searchParams)
  if (!actionFilter.ok) {
    return NextResponse.json({ error: actionFilter.error }, { status: 400 })
  }

  const severity = searchParams.get('severity')
  const severityFilter = buildSeverityFilter(severity)

  const where = {
    actorId: user.id,
    ...actionFilter.clause,
    ...severityFilter,
  }

  const [total, events] = await Promise.all([
    prisma.auditEvent.count({ where }),
    prisma.auditEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ])

  const totalPages = Math.ceil(total / limit)

  return NextResponse.json({
    events: events.map(event => ({
      id: event.id,
      action: event.eventType,
      resourceType: 'invoice',
      resourceId: event.invoiceId,
      ipAddress: null,
      severity: getSeverity(event.eventType),
      createdAt: event.createdAt,
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages,
    },
  })
}

export const GET = withRequestId(GETHandler)
