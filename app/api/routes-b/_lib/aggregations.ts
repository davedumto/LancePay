import { prisma } from '@/lib/db'

export const KNOWN_INVOICE_STATUSES = ['pending', 'paid', 'cancelled', 'overdue'] as const

export type InvoiceStatusSummary = {
  status: string
  count: number
  total: number
}

export async function getInvoiceStatusSummary(userId: string): Promise<InvoiceStatusSummary[]> {
  const grouped = await prisma.invoice.groupBy({
    by: ['status'],
    where: { userId },
    _count: { id: true },
    _sum: { amount: true },
  })

  const byStatus = new Map(
    grouped.map((row) => [row.status, { count: row._count.id, total: Number(row._sum.amount ?? 0) }]),
  )

  return KNOWN_INVOICE_STATUSES.map((status) => {
    const row = byStatus.get(status)
    return {
      status,
      count: row?.count ?? 0,
      total: row?.total ?? 0,
    }
  })
}

type DashboardSummary = {
  summary: {
    invoices: {
      total: number
      pending: number
      paid: number
      overdue: number
      cancelled: number
    }
    earnings: {
      totalEarned: number
      thisMonth: number
      currency: string
    }
    recentTransactions: Array<{
      id: string
      type: string
      amount: number
      currency: string
      createdAt: Date
    }>
  }
  queryCount: number
}

export async function buildDashboardSummary(userId: string, now = new Date()): Promise<DashboardSummary> {
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
  let queryCount = 0
  const countQuery = <T>(promise: Promise<T>) => {
    queryCount += 1
    return promise
  }

  const [invoiceStats, totalEarned, thisMonthEarned, recentTxns] = await Promise.all([
    countQuery(prisma.invoice.groupBy({ by: ['status'], where: { userId }, _count: { id: true } })),
    countQuery(
      prisma.transaction.aggregate({
        where: { userId, type: 'payment', status: 'completed' },
        _sum: { amount: true },
      }),
    ),
    countQuery(
      prisma.transaction.aggregate({
        where: { userId, type: 'payment', status: 'completed', createdAt: { gte: startOfMonth } },
        _sum: { amount: true },
      }),
    ),
    countQuery(
      prisma.transaction.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, type: true, amount: true, currency: true, createdAt: true },
      }),
    ),
  ])

  const counts = {
    pending: 0,
    paid: 0,
    overdue: 0,
    cancelled: 0,
  }

  for (const row of invoiceStats) {
    const status = row.status as keyof typeof counts
    if (status in counts) {
      counts[status] = row._count.id
    }
  }

  return {
    queryCount,
    summary: {
      invoices: {
        total: counts.pending + counts.paid + counts.overdue + counts.cancelled,
        pending: counts.pending,
        paid: counts.paid,
        overdue: counts.overdue,
        cancelled: counts.cancelled,
      },
      earnings: {
        totalEarned: Number(totalEarned._sum.amount ?? 0),
        thisMonth: Number(thisMonthEarned._sum.amount ?? 0),
        currency: 'USDC',
      },
      recentTransactions: recentTxns.map((txn) => ({
        id: txn.id,
        type: txn.type,
        amount: Number(txn.amount),
        currency: txn.currency,
        createdAt: txn.createdAt,
      })),
    },
  }
}
