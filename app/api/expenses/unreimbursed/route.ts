import { NextRequest, NextResponse } from 'next/server'
import { Decimal } from '@prisma/client/runtime/library'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { convertAmount, findFxRate, serializeFxRate, type ResolvedFxRate } from '@/lib/fx-rates'

// GET /api/expenses/unreimbursed[?projectId=] — the caller's expenses that no
// invoice reimburses yet (no ExpenseReimbursementMatch), converted to the
// user's home currency twice: with the FxRateSnapshot in effect when the
// expense was incurred (latest capturedAt <= expenseDate) and with the latest
// snapshot, for comparison. If any expense has no rate recorded the request
// fails with 422 rather than returning partial totals.

class FxUnavailableError extends Error {
  constructor(readonly details: Record<string, unknown>) {
    super('FX rate unavailable')
  }
}

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true, homeCurrency: true },
    })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const projectId = new URL(request.url).searchParams.get('projectId')
    if (projectId !== null) {
      if (projectId.trim() === '') {
        return NextResponse.json({ error: 'projectId must not be empty' }, { status: 400 })
      }
      const project = await prisma.project.findFirst({
        where: { id: projectId, userId: user.id },
        select: { id: true },
      })
      if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const expenses = await prisma.expense.findMany({
      where: {
        userId: user.id,
        reimbursementMatch: { is: null },
        ...(projectId !== null ? { projectId } : {}),
      },
      select: {
        id: true,
        category: true,
        description: true,
        amount: true,
        currency: true,
        expenseDate: true,
        projectId: true,
        receiptUrl: true,
      },
      orderBy: [{ expenseDate: 'desc' }, { id: 'asc' }],
    })

    const homeCurrency = user.homeCurrency.toUpperCase()
    const rateCache = new Map<string, Promise<ResolvedFxRate | null>>()
    const rateFor = async (currency: string, asOf: Date | undefined, expenseId: string) => {
      const key = `${currency.toUpperCase()}|${asOf?.toISOString() ?? 'latest'}`
      let pending = rateCache.get(key)
      if (!pending) {
        pending = findFxRate(currency, homeCurrency, asOf)
        rateCache.set(key, pending)
      }
      const resolved = await pending
      if (!resolved) {
        throw new FxUnavailableError({
          expenseId,
          fromCurrency: currency,
          toCurrency: homeCurrency,
          asOf: asOf?.toISOString() ?? null,
        })
      }
      return resolved
    }

    let totalAtIncurred = new Decimal(0)
    let totalAtCurrent = new Decimal(0)

    const rows = []
    for (const expense of expenses) {
      const [historical, current] = await Promise.all([
        rateFor(expense.currency, expense.expenseDate, expense.id),
        rateFor(expense.currency, undefined, expense.id),
      ])
      const atIncurred = convertAmount(expense.amount, historical)
      const atCurrent = convertAmount(expense.amount, current)
      totalAtIncurred = totalAtIncurred.plus(atIncurred)
      totalAtCurrent = totalAtCurrent.plus(atCurrent)

      rows.push({
        ...expense,
        amount: expense.amount.toString(),
        expenseDate: expense.expenseDate.toISOString(),
        converted: {
          currency: homeCurrency,
          atIncurred: { amount: atIncurred.toFixed(2), ...serializeFxRate(historical) },
          atCurrentRate: { amount: atCurrent.toFixed(2), ...serializeFxRate(current) },
          difference: atCurrent.minus(atIncurred).toFixed(2),
        },
      })
    }

    return NextResponse.json({
      homeCurrency,
      projectId,
      expenses: rows,
      totals: {
        count: rows.length,
        atIncurred: totalAtIncurred.toFixed(2),
        atCurrentRate: totalAtCurrent.toFixed(2),
        difference: totalAtCurrent.minus(totalAtIncurred).toFixed(2),
      },
    })
  } catch (error) {
    if (error instanceof FxUnavailableError) {
      return NextResponse.json(
        {
          error: 'No exchange rate is recorded for one or more expenses',
          code: 'FX_RATE_UNAVAILABLE',
          details: error.details,
        },
        { status: 422 },
      )
    }
    logger.error({ err: error }, 'GET /api/expenses/unreimbursed error')
    return NextResponse.json({ error: 'Failed to fetch unreimbursed expenses' }, { status: 500 })
  }
}
