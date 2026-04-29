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

  const grouped = await prisma.invoice.groupBy({
    by: ['status'],
    where: { userId: user.id },
    _count: { id: true },
    _sum: { amount: true },
  })

  const stats = INVOICE_STATUSES.reduce<Record<InvoiceStatus, { count: number; totalAmount: number }>>(
    (acc, status) => {
      acc[status] = { count: 0, totalAmount: 0 }
      return acc
    },
    {} as any,
  )

  let totalCount = 0
  let totalInvoiced = 0

  for (const row of grouped) {
    const status = row.status as InvoiceStatus
    if (INVOICE_STATUSES.includes(status)) {
      stats[status].count = row._count.id
      const amount = Number(row._sum.amount ?? 0)
      stats[status].totalAmount = amount
      totalCount += row._count.id
      totalInvoiced += amount
    }
  }

  const distribution = INVOICE_STATUSES.reduce<Record<InvoiceStatus, { count: number; percentage: number }>>(
    (acc, status) => {
      const count = stats[status].count
      acc[status] = {
        count,
        percentage: totalCount > 0 ? Number(((count / totalCount) * 100).toFixed(2)) : 0,
      }
      return acc
    },
    {} as any,
  )

  return withCompression(
    request,
    NextResponse.json({
      invoices: {
        total: totalCount,
        pending: stats.pending.count,
        paid: stats.paid.count,
        overdue: stats.overdue.count,
        cancelled: stats.cancelled.count,
        totalInvoiced,
        distribution,
      },
    }),
  )
}


export const GET = withRequestId(GETHandler)
