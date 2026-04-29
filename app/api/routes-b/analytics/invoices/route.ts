import { withRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { withCompression } from '../../_lib/with-compression'

const INVOICE_STATUSES = ['pending', 'paid', 'overdue', 'cancelled'] as const
type InvoiceStatus = (typeof INVOICE_STATUSES)[number]

async function GETHandler(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const [grouped, totals] = await Promise.all([
    prisma.invoice.groupBy({
      by: ['status'],
      where: { userId: user.id },
      _count: { id: true },
    }),
    prisma.invoice.aggregate({
      where: { userId: user.id },
      _count: { id: true },
      _sum: { amount: true },
    }),
  ])

  const counts = INVOICE_STATUSES.reduce<Record<InvoiceStatus, number>>(
    (acc, status) => {
      acc[status] = 0
      return acc
    },
    {} as Record<InvoiceStatus, number>,
  )

  for (const row of grouped) {
    if (INVOICE_STATUSES.includes(row.status as InvoiceStatus)) {
      counts[row.status as InvoiceStatus] = row._count.id
    }
  }

  const total = counts.pending + counts.paid + counts.overdue + counts.cancelled

  return withCompression(request, NextResponse.json({
    invoices: {
      total,
      pending: counts.pending,
      paid: counts.paid,
      overdue: counts.overdue,
      cancelled: counts.cancelled,
      totalInvoiced: Number(totals._sum.amount ?? 0),
    },
  }))
}

export const GET = withRequestId(GETHandler)
