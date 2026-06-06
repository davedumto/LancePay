import { prisma } from '@/lib/db'
import { aggregateGroups } from './currency'

export const KNOWN_INVOICE_STATUSES = ['pending', 'paid', 'cancelled', 'overdue'] as const

export type InvoiceStatusSummary = {
  status: string
  count: number
  total: number | Record<string, number>
}

export async function getInvoiceStatusSummary(userId: string): Promise<InvoiceStatusSummary[]> {
  const grouped = await prisma.invoice.groupBy({
    by: ['status', 'currency'],
    where: { userId },
    _count: { id: true },
    _sum: { amount: true },
  })

  const byStatus = new Map<string, { count: number; groups: any[] }>()

  for (const row of grouped) {
    const existing = byStatus.get(row.status) || { count: 0, groups: [] }
    existing.count += row._count.id
    existing.groups.push(row)
    byStatus.set(row.status, existing)
  }

  return KNOWN_INVOICE_STATUSES.map((status) => {
    const data = byStatus.get(status)
    return {
      status,
      count: data?.count ?? 0,
      total: data ? aggregateGroups(data.groups) : 0,
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
      totalEarned: number | Record<string, number>
      thisMonth: number | Record<string, number>
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
      prisma.transaction.groupBy({
        by: ['currency'],
        where: { userId, type: 'payment', status: 'completed' },
        _sum: { amount: true },
      }),
    ),
    countQuery(
      prisma.transaction.groupBy({
        by: ['currency'],
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
        totalEarned: aggregateGroups(totalEarned),
        thisMonth: aggregateGroups(thisMonthEarned),
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
