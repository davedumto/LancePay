import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return null
  return prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true, taxPercentage: true },
  })
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const yearParam = searchParams.get('year')
    const year = yearParam ? parseInt(yearParam, 10) : new Date().getFullYear()

    if (isNaN(year) || year < 2000 || year > 2100) {
      return NextResponse.json({ error: 'Invalid year parameter' }, { status: 400 })
    }

    const start = new Date(`${year}-01-01T00:00:00Z`)
    const end = new Date(`${year + 1}-01-01T00:00:00Z`)

    const [income, expenses] = await Promise.all([
      prisma.transaction.findMany({
        where: {
          userId: user.id,
          type: 'payment',
          status: 'completed',
          createdAt: { gte: start, lt: end },
        },
        select: { amount: true, currency: true },
      }),
      prisma.expense.findMany({
        where: {
          userId: user.id,
          expenseDate: { gte: start, lt: end },
        },
        select: { amount: true, currency: true },
      }),
    ])

    const grossIncome = income.reduce((sum, tx) => sum + Number(tx.amount), 0)
    const totalExpenses = expenses.reduce((sum, ex) => sum + Number(ex.amount), 0)
    const netIncome = grossIncome - totalExpenses
    const taxRate = Number(user.taxPercentage) / 100
    const estimatedTax = Math.max(0, netIncome * taxRate)

    return NextResponse.json({
      year,
      currency: 'USDC',
      grossIncome,
      totalExpenses,
      netIncome,
      taxRate: Number(user.taxPercentage),
      estimatedTax: Math.round(estimatedTax * 100) / 100,
      incomeTransactionCount: income.length,
      expenseCount: expenses.length,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-b/reports/tax-summary error')
    return NextResponse.json({ error: 'Failed to generate tax summary' }, { status: 500 })
  }
}
