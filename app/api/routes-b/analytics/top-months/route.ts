import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

/**
 * GET /api/routes-b/analytics/top-months
 * Returns the three calendar months with the highest paid invoice totals for the authenticated user.
 */
export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Fetch all paid invoices for the user
    const paid = await prisma.invoice.findMany({
      where: { userId: user.id, status: 'paid' },
      select: { amount: true, paidAt: true },
    })

    // Group by "YYYY-MM" in application code (Prisma does not support month-level groupBy portably)
    const monthly: Record<string, number> = {}
    for (const inv of paid) {
      if (!inv.paidAt) continue
      const key = inv.paidAt.toISOString().slice(0, 7) // "2025-01"
      monthly[key] = (monthly[key] ?? 0) + Number(inv.amount)
    }

    // Sort by earned amount descending and take top 3
    const topMonths = Object.entries(monthly)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([month, earned]) => ({ 
        month, 
        earned: Number(earned.toFixed(2)) 
      }))

    return NextResponse.json({ topMonths })
  } catch (error) {
    console.error('Top months analytics error:', error)
    return NextResponse.json({ error: 'Failed to fetch analytics' }, { status: 500 })
  }
}
