import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

// GET /api/routes-b/analytics/invoices — invoice counts grouped by status
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

    const [grouped, totals] = await Promise.all([
      prisma.invoice.groupBy({
        by: ['status'],
        where: { userId: user.id },
        _count: { id: true },
      }),
      prisma.invoice.aggregate({
        where: { userId: user.id },
        _count: { id: true },
        _sum: { amount: true },
      }),
    ])

    const counts = { pending: 0, paid: 0, overdue: 0, cancelled: 0 }
    for (const row of grouped) {
      const status = row.status as keyof typeof counts
      if (status in counts) {
        counts[status] = row._count.id
      }
    }

    return NextResponse.json({
      invoices: {
        total: totals._count.id,
        pending: counts.pending,
        paid: counts.paid,
        overdue: counts.overdue,
        cancelled: counts.cancelled,
        totalInvoiced: totals._sum.amount ?? 0,
      }
    })
  } catch (error) {
    console.error('Error fetching invoice analytics:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}