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

  const now = new Date()
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)

  const [invoiceStats, totalEarned, thisMonthEarned, recentTxns] = await Promise.all([
    prisma.invoice.groupBy({ by: ['status'], where: { userId: user.id }, _count: { id: true } }),
    prisma.transaction.aggregate({
      where: { userId: user.id, type: 'payment', status: 'completed' },
      _sum: { amount: true },
    }),
    prisma.transaction.aggregate({
      where: {
        userId: user.id,
        type: 'payment',
        status: 'completed',
        createdAt: { gte: startOfMonth },
      },
      _sum: { amount: true },
    }),
    prisma.transaction.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, type: true, amount: true, currency: true, createdAt: true },
    }),
  ])

  const counts = INVOICE_STATUSES.reduce<Record<InvoiceStatus, number>>(
    (acc, status) => {
      acc[status] = 0
      return acc
    },
    {} as Record<InvoiceStatus, number>,
  )

  for (const row of invoiceStats) {
    if (INVOICE_STATUSES.includes(row.status as InvoiceStatus)) {
      counts[row.status as InvoiceStatus] = row._count.id
    }
  }

  return NextResponse.json({
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
      recentTransactions: recentTxns.map(txn => ({
        id: txn.id,
        type: txn.type,
        amount: Number(txn.amount),
        currency: txn.currency,
        createdAt: txn.createdAt,
      })),
    },
  })
}
