import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

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

    const url = new URL(request.url)
    const yearParam = url.searchParams.get('year')
    const currentYear = yearParam ? parseInt(yearParam, 10) : new Date().getFullYear()

    if (isNaN(currentYear) || currentYear < 2000 || currentYear > 2100) {
      return NextResponse.json({ error: 'Invalid year parameter' }, { status: 400 })
    }

    const previousYear = currentYear - 1

    // Get transactions for current year
    const currentYearTransactions = await prisma.transaction.findMany({
      where: {
        userId: user.id,
        type: 'payment',
        status: 'completed',
        createdAt: {
          gte: new Date(`${currentYear}-01-01T00:00:00Z`),
          lt: new Date(`${currentYear + 1}-01-01T00:00:00Z`),
        },
      },
    })

    // Get transactions for previous year
    const previousYearTransactions = await prisma.transaction.findMany({
      where: {
        userId: user.id,
        type: 'payment',
        status: 'completed',
        createdAt: {
          gte: new Date(`${previousYear}-01-01T00:00:00Z`),
          lt: new Date(`${currentYear}-01-01T00:00:00Z`),
        },
      },
    })

    // Calculate totals
    const currentYearTotal = currentYearTransactions.reduce(
      (sum: number, tx: any) => sum + Number(tx.amount),
      0,
    )
    const previousYearTotal = previousYearTransactions.reduce(
      (sum: number, tx: any) => sum + Number(tx.amount),
      0,
    )

    // Calculate percentage change
    const percentageChange =
      previousYearTotal > 0
        ? ((currentYearTotal - previousYearTotal) / previousYearTotal) * 100
        : currentYearTotal > 0
          ? 100
          : 0

    // Group by month for detailed comparison
    const monthlyComparison = []
    for (let month = 1; month <= 12; month++) {
      const monthStart = new Date(`${currentYear}-${String(month).padStart(2, '0')}-01T00:00:00Z`)
      const monthEnd = new Date(`${currentYear}-${String(month).padStart(2, '0')}-01T00:00:00Z`)
      monthEnd.setMonth(monthEnd.getMonth() + 1)

      const currentMonthTransactions = currentYearTransactions.filter(
        (tx: any) => tx.createdAt >= monthStart && tx.createdAt < monthEnd,
      )
      const currentMonthTotal = currentMonthTransactions.reduce(
        (sum: number, tx: any) => sum + Number(tx.amount),
        0,
      )

      const prevMonthStart = new Date(`${previousYear}-${String(month).padStart(2, '0')}-01T00:00:00Z`)
      const prevMonthEnd = new Date(`${previousYear}-${String(month).padStart(2, '0')}-01T00:00:00Z`)
      prevMonthEnd.setMonth(prevMonthEnd.getMonth() + 1)

      const prevMonthTransactions = previousYearTransactions.filter(
        (tx: any) => tx.createdAt >= prevMonthStart && tx.createdAt < prevMonthEnd,
      )
      const prevMonthTotal = prevMonthTransactions.reduce(
        (sum: number, tx: any) => sum + Number(tx.amount),
        0,
      )

      const monthPercentageChange =
        prevMonthTotal > 0
          ? ((currentMonthTotal - prevMonthTotal) / prevMonthTotal) * 100
          : currentMonthTotal > 0
            ? 100
            : 0

      monthlyComparison.push({
        month,
        currentYearAmount: currentMonthTotal,
        previousYearAmount: prevMonthTotal,
        percentageChange: Math.round(monthPercentageChange * 100) / 100,
      })
    }

    return NextResponse.json({
      year: currentYear,
      previousYear,
      currentYearTotal,
      previousYearTotal,
      percentageChange: Math.round(percentageChange * 100) / 100,
      currency: 'USDC',
      monthlyComparison,
    })
  } catch (error) {
    logger.error({ err: error }, 'Year-over-year report error')
    return NextResponse.json({ error: 'Failed to generate year-over-year report' }, { status: 500 })
  }
}
