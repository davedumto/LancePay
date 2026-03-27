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

    // Parse query parameters
    const { searchParams } = new URL(request.url)
    const months = Math.min(24, Math.max(1, parseInt(searchParams.get('months') || '6', 10)))

    // Calculate date range
    const now = new Date()
    const startDate = new Date(now.getFullYear(), now.getMonth() - months + 1, 1)

    // Get all paid invoices in range
    const invoices = await prisma.invoice.findMany({
      where: {
        userId: user.id,
        status: 'paid',
        paidAt: { gte: startDate },
      },
      select: {
        amount: true,
        paidAt: true,
      },
    })

    // Group by month
    const monthlyData: { [key: string]: number } = {}
    
    for (let i = 0; i < months; i++) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
      monthlyData[key] = 0
    }

    for (const invoice of invoices) {
      if (invoice.paidAt) {
        const key = `${invoice.paidAt.getFullYear()}-${String(invoice.paidAt.getMonth() + 1).padStart(2, '0')}`
        if (monthlyData[key] !== undefined) {
          monthlyData[key] += invoice.amount.toNumber()
        }
      }
    }

    // Convert to array format
    const summary = Object.entries(monthlyData)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, earnings]) => ({
        month,
        earnings,
      }))

    return NextResponse.json({ summary })
  } catch (error) {
    logger.error({ err: error }, 'Invoice summary error')
    return NextResponse.json({ error: 'Failed to get invoice summary' }, { status: 500 })
  }
}