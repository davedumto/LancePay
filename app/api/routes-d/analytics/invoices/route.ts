import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const INVOICE_STATUSES = ['pending', 'paid', 'overdue', 'cancelled'] as const
type InvoiceStatus = (typeof INVOICE_STATUSES)[number]

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
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
      {} as Record<InvoiceStatus, { count: number; totalAmount: number }>,
    )

    let total = 0
    let totalInvoiced = 0

    for (const row of grouped) {
      const status = row.status as InvoiceStatus
      if (!INVOICE_STATUSES.includes(status)) continue

      const amount = Number(row._sum.amount ?? 0)
      stats[status] = {
        count: row._count.id,
        totalAmount: amount,
      }
      total += row._count.id
      totalInvoiced += amount
    }

    const distribution = INVOICE_STATUSES.reduce<Record<InvoiceStatus, { count: number; percentage: number }>>(
      (acc, status) => {
        const count = stats[status].count
        acc[status] = {
          count,
          percentage: total > 0 ? Number(((count / total) * 100).toFixed(2)) : 0,
        }
        return acc
      },
      {} as Record<InvoiceStatus, { count: number; percentage: number }>,
    )

    return NextResponse.json({
      invoices: {
        total,
        pending: stats.pending.count,
        paid: stats.paid.count,
        overdue: stats.overdue.count,
        cancelled: stats.cancelled.count,
        totalInvoiced,
        distribution,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/analytics/invoices error')
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
