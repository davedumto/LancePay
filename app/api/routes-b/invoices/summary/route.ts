import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

// GET /api/routes-b/invoices/summary — monthly invoice earnings summary
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

    const { searchParams } = new URL(request.url)
    const monthsParam = parseInt(searchParams.get('months') || '6')
    const months = Math.min(12, Math.max(1, isNaN(monthsParam) ? 6 : monthsParam))

    const results = []

    for (let i = months - 1; i >= 0; i--) {
      const date = new Date()
      const start = new Date(date.getFullYear(), date.getMonth() - i, 1)
      const end = new Date(date.getFullYear(), date.getMonth() - i + 1, 0, 23, 59, 59, 999)

      const agg = await prisma.invoice.aggregate({
        where: {
          userId: user.id,
          status: 'paid',
          paidAt: { gte: start, lte: end },
        },
        _count: { id: true },
        _sum: { amount: true },
      })

      results.push({
        month: start.toISOString().slice(0, 7),
        invoicesPaid: agg._count.id,
        earned: Number(agg._sum.amount ?? 0),
      })
    }

    return NextResponse.json({ summary: results })
  } catch (error) {
    console.error('Error fetching invoice summary:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}