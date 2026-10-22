import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
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
      select: { id: true },
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Get all invoices for this user with analytics
    const invoices = await prisma.invoice.findMany({
      where: { userId: user.id },
      select: {
        id: true,
        amount: true,
        status: true,
        dueDate: true,
        createdAt: true,
        clientId: true,
      },
      orderBy: { createdAt: 'desc' },
    })

    // Calculate analytics
    const analytics = {
      totalInvoices: invoices.length,
      totalAmount: 0,
      paidAmount: 0,
      pendingAmount: 0,
      overdueAmount: 0,
      cancelledAmount: 0,
      byStatus: {
        paid: 0,
        pending: 0,
        overdue: 0,
        cancelled: 0,
      },
      invoices: [] as Array<{
        id: string
        amount: number
        status: string
        dueDate: Date | null
        createdAt: Date
        clientId: string
      }>,
    }

    const now = new Date()

    invoices.forEach((invoice) => {
      const amount = invoice.amount ? Number(invoice.amount) : 0
      analytics.invoices.push({
        id: invoice.id,
        amount,
        status: invoice.status,
        dueDate: invoice.dueDate,
        createdAt: invoice.createdAt,
        clientId: invoice.clientId || '',
      })
      analytics.totalAmount += amount

      switch (invoice.status) {
        case 'paid':
          analytics.paidAmount += amount
          analytics.byStatus.paid += 1
          break
        case 'pending':
          if (invoice.dueDate && invoice.dueDate < now) {
            analytics.overdueAmount += amount
            analytics.byStatus.overdue += 1
          } else {
            analytics.pendingAmount += amount
            analytics.byStatus.pending += 1
          }
          break
        case 'overdue':
          analytics.overdueAmount += amount
          analytics.byStatus.overdue += 1
          break
        case 'cancelled':
          analytics.cancelledAmount += amount
          analytics.byStatus.cancelled += 1
          break
      }
    })

    return NextResponse.json(analytics)
  } catch (error) {
    logger.error({ err: error }, 'Get invoice analytics error')
    return NextResponse.json({ error: 'Failed to get invoice analytics' }, { status: 500 })
  }
}
