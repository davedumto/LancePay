import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

// GET /api/routes-b/dashboard — combined dashboard summary
export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const now = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)

    const [invoiceStats, totalEarned, thisMonthEarned, recentTxns] = await Promise.all([
      prisma.invoice.groupBy({
        by: ['status'],
        where: { userId: user.id },
        _count: { id: true },
      }),
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
        select: {
          id: true,
          type: true,
          amount: true,
          currency: true,
          createdAt: true,
        },
      }),
    ])

    // Build invoice status counts
    const invoiceCounts = { pending: 0, paid: 0, overdue: 0, cancelled: 0 }
    for (const row of invoiceStats) {
      const status = row.status as keyof typeof invoiceCounts
      if (status in invoiceCounts) {
        invoiceCounts[status] = row._count.id
      }
    }

    const totalInvoices = Object.values(invoiceCounts).reduce((a, b) => a + b, 0)

    return NextResponse.json({
      summary: {
        invoices: {
          total: totalInvoices,
          pending: invoiceCounts.pending,
          paid: invoiceCounts.paid,
          overdue: invoiceCounts.overdue,
          cancelled: invoiceCounts.cancelled,
        },
        earnings: {
          totalEarned: totalEarned._sum.amount ?? 0,
          thisMonth: thisMonthEarned._sum.amount ?? 0,
          currency: 'USDC',
        },
        recentTransactions: recentTxns.map((tx) => ({
          id: tx.id,
          type: tx.type,
          amount: tx.amount,
          currency: tx.currency,
          createdAt: tx.createdAt,
        })),
      },
    })
  } catch (error) {
    console.error('Error fetching dashboard:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}