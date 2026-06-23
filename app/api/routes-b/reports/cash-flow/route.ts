import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const FORECAST_MONTHS = 3

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return null
  return prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const now = new Date()
    const currentYear = now.getUTCFullYear()
    const currentMonth = now.getUTCMonth() // 0-indexed

    // Rolling 6-month window for the historical average used in the forecast
    const historyStart = new Date(Date.UTC(currentYear, currentMonth - 6, 1))
    const monthStart = new Date(Date.UTC(currentYear, currentMonth, 1))

    const [completedIncome, pendingInvoices, recentExpenses] = await Promise.all([
      prisma.transaction.findMany({
        where: {
          userId: user.id,
          type: 'payment',
          status: 'completed',
          createdAt: { gte: historyStart, lt: monthStart },
        },
        select: { amount: true, createdAt: true },
      }),
      prisma.invoice.findMany({
        where: {
          userId: user.id,
          status: { in: ['pending', 'overdue'] },
          dueDate: { not: null },
        },
        select: { amount: true, dueDate: true, status: true },
      }),
      prisma.expense.findMany({
        where: {
          userId: user.id,
          expenseDate: { gte: historyStart, lt: monthStart },
        },
        select: { amount: true, expenseDate: true },
      }),
    ])

    const historicalMonths = 6
    const avgMonthlyIncome =
      completedIncome.reduce((s, t) => s + Number(t.amount), 0) / historicalMonths
    const avgMonthlyExpenses =
      recentExpenses.reduce((s, e) => s + Number(e.amount), 0) / historicalMonths
    const avgNetCashFlow = avgMonthlyIncome - avgMonthlyExpenses

    const forecast = Array.from({ length: FORECAST_MONTHS }, (_, i) => {
      const forecastDate = new Date(Date.UTC(currentYear, currentMonth + i, 1))
      const forecastYear = forecastDate.getUTCFullYear()
      const forecastMonth = forecastDate.getUTCMonth() + 1

      const expectedInvoicePayments = pendingInvoices
        .filter((inv) => {
          if (!inv.dueDate) return false
          const d = new Date(inv.dueDate)
          return d.getUTCFullYear() === forecastYear && d.getUTCMonth() + 1 === forecastMonth
        })
        .reduce((s, inv) => s + Number(inv.amount), 0)

      const projectedIncome = avgMonthlyIncome + expectedInvoicePayments
      const projectedExpenses = avgMonthlyExpenses
      const netCashFlow = projectedIncome - projectedExpenses

      return {
        year: forecastYear,
        month: forecastMonth,
        projectedIncome: Math.round(projectedIncome * 100) / 100,
        projectedExpenses: Math.round(projectedExpenses * 100) / 100,
        expectedInvoicePayments: Math.round(expectedInvoicePayments * 100) / 100,
        netCashFlow: Math.round(netCashFlow * 100) / 100,
      }
    })

    return NextResponse.json({
      currency: 'USDC',
      averageMonthlyIncome: Math.round(avgMonthlyIncome * 100) / 100,
      averageMonthlyExpenses: Math.round(avgMonthlyExpenses * 100) / 100,
      averageNetCashFlow: Math.round(avgNetCashFlow * 100) / 100,
      pendingInvoiceCount: pendingInvoices.length,
      forecast,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-b/reports/cash-flow error')
    return NextResponse.json({ error: 'Failed to generate cash-flow forecast' }, { status: 500 })
  }
}
