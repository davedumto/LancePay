import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

// GET /api/routes-b/invoices/overdue — list overdue invoices
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

    const invoices = await prisma.invoice.findMany({
      where: {
        userId: user.id,
        status: 'pending',
        dueDate: { not: null, lt: now },
      },
      orderBy: { dueDate: 'asc' },
      select: {
        id: true,
        invoiceNumber: true,
        clientName: true,
        clientEmail: true,
        amount: true,
        dueDate: true,
      },
    })

    const overdueInvoices = invoices.map((invoice) => {
      const daysOverdue = Math.floor(
        (now.getTime() - (invoice.dueDate?.getTime() || 0)) / (1000 * 60 * 60 * 24)
      )

      return {
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        clientName: invoice.clientName,
        clientEmail: invoice.clientEmail,
        amount: invoice.amount,
        dueDate: invoice.dueDate,
        daysOverdue,
      }
    })

    return NextResponse.json({
      invoices: overdueInvoices,
      total: overdueInvoices.length,
    })
  } catch (error) {
    console.error('Error fetching overdue invoices:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}