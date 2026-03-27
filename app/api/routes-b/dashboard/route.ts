import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    // Verify auth
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Calculate date ranges
    const now = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)

    // Run all queries in parallel
    const [
      totalInvoices,
      paidInvoices,
      pendingInvoices,
      overdueInvoices,
      totalEarnings,
      monthlyEarnings,
      lastMonthEarnings,
      bankAccountsCount,
    ] = await Promise.all([
      // Total invoices
      prisma.invoice.count({ where: { userId: user.id } }),
      // Paid invoices
      prisma.invoice.count({ where: { userId: user.id, status: 'paid' } }),
      // Pending invoices
      prisma.invoice.count({ where: { userId: user.id, status: 'pending' } }),
      // Overdue invoices
      prisma.invoice.count({
        where: {
          userId: user.id,
          status: 'pending',
          dueDate: { lt: now },
        },
      }),
      // Total earnings (all time)
      prisma.invoice.aggregate({
        where: { userId: user.id, status: 'paid' },
        _sum: { amount: true },
      }),
      // This month earnings
      prisma.invoice.aggregate({
        where: {
          userId: user.id,
          status: 'paid',
          paidAt: { gte: startOfMonth },
        },
        _sum: { amount: true },
      }),
      // Last month earnings
      prisma.invoice.aggregate({
        where: {
          userId: user.id,
          status: 'paid',
          paidAt: { gte: startOfLastMonth, lt: startOfMonth },
        },
        _sum: { amount: true },
      }),
      // Bank accounts count
      prisma.bankAccount.count({ where: { userId: user.id } }),
    ])

    return NextResponse.json({
      invoices: {
        total: totalInvoices,
        paid: paidInvoices,
        pending: pendingInvoices,
        overdue: overdueInvoices,
      },
      earnings: {
        total: totalEarnings._sum.amount?.toNumber() || 0,
        thisMonth: monthlyEarnings._sum.amount?.toNumber() || 0,
        lastMonth: lastMonthEarnings._sum.amount?.toNumber() || 0,
      },
      bankAccounts: bankAccountsCount,
    })
  } catch (error) {
    logger.error({ err: error }, 'Dashboard error')
    return NextResponse.json({ error: 'Failed to get dashboard' }, { status: 500 })
  }
}