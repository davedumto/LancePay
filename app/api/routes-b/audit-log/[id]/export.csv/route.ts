import { withRequestId } from '../../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { parseAuditFilters } from '../../../_lib/audit-filters'
import { createCsvStream } from '../../../_lib/csv-stream'

const EXPORT_ROW_LIMIT = 50_000

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

  const where: Prisma.AuditEventWhereInput = {
    invoiceId: id,
    createdAt: {
      gte: filters.value.from,
      lte: filters.value.to,
    },
    ...(filters.value.actor ? { actorId: filters.value.actor } : {}),
    invoice: {
      userId: user.id,
    },
  }

  const rowCount = await prisma.auditEvent.count({ where })
  if (rowCount > EXPORT_ROW_LIMIT) {
    return NextResponse.json(
      {
        error: 'Audit export is too large',
        hint: 'request-narrower-range',
      },
      { status: 413 },
    )
  }

  type AuditEventRow = {
    id: string
    eventType: string
    invoiceId: string
    actorId: string | null
    metadata: unknown
    createdAt: Date
  }

  const stream = createCsvStream<AuditEventRow>(
    [
      { header: 'id', value: row => row.id },
      { header: 'action', value: row => row.eventType },
      { header: 'resourceType', value: () => 'invoice' },
      { header: 'resourceId', value: row => row.invoiceId },
      { header: 'actorId', value: row => row.actorId },
      { header: 'metadata', value: row => JSON.stringify(row.metadata ?? {}) },
      { header: 'createdAt', value: row => row.createdAt },
    ],
    (cursor, batchSize) =>
      prisma.auditEvent.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: batchSize,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          eventType: true,
          invoiceId: true,
          actorId: true,
          metadata: true,
          createdAt: true,
        },
      }),
  )

  return new NextResponse(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="audit-log-${id}.csv"`,
    },
  })
}

export const GET = withRequestId(GETHandler)
