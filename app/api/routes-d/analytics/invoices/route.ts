import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const INVOICE_STATUSES = ['pending', 'paid', 'overdue', 'cancelled'] as const
type InvoiceStatus = (typeof INVOICE_STATUSES)[number]

export async function GET(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  // Count invoices grouped by status
  const grouped = await prisma.invoice.groupBy({
    by: ['status'],
    where: { userId: user.id },
    _count: { id: true },
  })

  // Aggregate total count and total invoiced amount
  const totals = await prisma.invoice.aggregate({
    where: { userId: user.id },
    _count: { id: true },
    _sum: { amount: true },
  })

  // Build a map from the grouped results, defaulting all known statuses to 0
  const countByStatus = INVOICE_STATUSES.reduce<Record<InvoiceStatus, number>>(
    (acc, status) => {
      acc[status] = 0
      return acc
    },
    {} as Record<InvoiceStatus, number>,
  )

  for (const row of grouped) {
    if (INVOICE_STATUSES.includes(row.status as InvoiceStatus)) {
      countByStatus[row.status as InvoiceStatus] = row._count.id
    }
  }

  return NextResponse.json({
    invoices: {
      total: totals._count.id,
      pending: countByStatus.pending,
      paid: countByStatus.paid,
      overdue: countByStatus.overdue,
      cancelled: countByStatus.cancelled,
      totalInvoiced: Number(totals._sum.amount ?? 0),
    },
  })
}
