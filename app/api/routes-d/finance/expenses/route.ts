import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { getOrCreateUserFromRequest, round2 } from '@/app/api/routes-d/finance/_shared'
import { storeExpenseReceiptFile, validateReceiptFile } from '@/lib/file-storage'
import { Decimal } from '@prisma/client/runtime/library'
import { logger } from '@/lib/logger'

const EXPENSE_CATEGORIES = [
  'Software',
  'Travel',
  'Marketing',
  'Equipment',
  'Contractor',
  'Office',
  'Internet',
  'Utilities',
  'Taxes',
  'Fees',
  'Other',
] as const

const ExpenseCreateSchema = z.object({
  category: z.enum(EXPENSE_CATEGORIES),
  description: z.string().min(1).max(255),
  amount: z.coerce.number().positive().finite(),
  currency: z.string().min(3).max(10).default('USDC'),
  expenseDate: z.coerce.date().optional(),
  notes: z.string().max(2000).optional(),
})

function serializeExpense(expense: {
  id: string
  category: string
  description: string
  amount: Decimal | { toString(): string }
  currency: string
  receiptUrl: string | null
  notes: string | null
  expenseDate: Date
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: expense.id,
    category: expense.category,
    description: expense.description,
    amount: Number(expense.amount),
    currency: expense.currency,
    receiptUrl: expense.receiptUrl,
    receiptDownloadUrl: expense.receiptUrl
      ? `/api/routes-d/finance/expenses/${expense.id}/receipt`
      : null,
    notes: expense.notes,
    expenseDate: expense.expenseDate.toISOString(),
    createdAt: expense.createdAt.toISOString(),
    updatedAt: expense.updatedAt.toISOString(),
  }
}

function parseDateOrNull(value: string | null) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

async function parseExpensePayload(request: NextRequest) {
  const contentType = request.headers.get('content-type') || ''

  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData()
    const parsed = ExpenseCreateSchema.safeParse({
      category: form.get('category'),
      description: form.get('description'),
      amount: form.get('amount'),
      currency: form.get('currency') || 'USDC',
      expenseDate: form.get('expenseDate') || undefined,
      notes: form.get('notes') || undefined,
    })

    if (!parsed.success) {
      return {
        error: parsed.error.issues[0]?.message || 'Invalid request',
      } as const
    }

    const receipt = form.get('receipt')
    if (receipt != null && !(receipt instanceof File)) {
      return { error: 'Invalid receipt file' } as const
    }

    return {
      data: parsed.data,
      receipt: receipt instanceof File ? receipt : null,
    } as const
  }

  const body = await request.json()
  const parsed = ExpenseCreateSchema.safeParse(body)
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message || 'Invalid request',
    } as const
  }

  return { data: parsed.data, receipt: null } as const
}

export async function GET(request: NextRequest) {
  try {
    const auth = await getOrCreateUserFromRequest(request)
    if ('error' in auth) {
      return NextResponse.json({ error: auth.error }, { status: 401 })
    }

    const category = request.nextUrl.searchParams.get('category') || undefined
    const from = parseDateOrNull(request.nextUrl.searchParams.get('from'))
    const to = parseDateOrNull(request.nextUrl.searchParams.get('to'))
    const limitParam = Number(request.nextUrl.searchParams.get('limit') || 50)
    const limit = Number.isFinite(limitParam)
      ? Math.max(1, Math.min(100, Math.trunc(limitParam)))
      : 50

    if (category && !EXPENSE_CATEGORIES.includes(category as (typeof EXPENSE_CATEGORIES)[number])) {
      return NextResponse.json({ error: 'Invalid category' }, { status: 400 })
    }

    const where = {
      userId: auth.user.id,
      ...(category ? { category } : {}),
      ...(from || to
        ? {
            expenseDate: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
    }

    const expenses = await prisma.expense.findMany({
      where,
      orderBy: [{ expenseDate: 'desc' }, { createdAt: 'desc' }],
      take: limit,
    })

    const aggregate = await prisma.expense.groupBy({
      by: ['category'],
      where,
      _sum: { amount: true },
      _count: { _all: true },
    })

    const total = round2(expenses.reduce((sum, e) => sum + Number(e.amount), 0))

    return NextResponse.json({
      categories: EXPENSE_CATEGORIES,
      total,
      count: expenses.length,
      breakdown: aggregate
        .map((row) => ({
          category: row.category,
          amount: round2(Number(row._sum.amount || 0)),
          count: row._count._all,
        }))
        .sort((a, b) => b.amount - a.amount),
      expenses: expenses.map(serializeExpense),
    })
  } catch (error) {
    logger.error({ err: error }, 'Expenses GET error:')
    return NextResponse.json({ error: 'Failed to list expenses' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await getOrCreateUserFromRequest(request)
    if ('error' in auth) {
      return NextResponse.json({ error: auth.error }, { status: 401 })
    }

    const payload = await parseExpensePayload(request)
    if ('error' in payload) {
      return NextResponse.json({ error: payload.error }, { status: 400 })
    }

    let receiptUrl: string | null = null
    if (payload.receipt) {
      const validation = validateReceiptFile(payload.receipt)
      if (!validation.valid) {
        return NextResponse.json({ error: validation.error }, { status: 400 })
      }
      receiptUrl = await storeExpenseReceiptFile(auth.user.id, payload.receipt)
    }

    const created = await prisma.expense.create({
      data: {
        userId: auth.user.id,
        category: payload.data.category,
        description: payload.data.description.trim(),
        amount: new Decimal(payload.data.amount.toFixed(6)),
        currency: payload.data.currency.trim().toUpperCase(),
        expenseDate: payload.data.expenseDate ?? new Date(),
        notes: payload.data.notes?.trim() || null,
        receiptUrl,
      },
    })

    return NextResponse.json(
      {
        expense: serializeExpense(created),
        categories: EXPENSE_CATEGORIES,
      },
      { status: 201 }
    )
  } catch (error) {
    logger.error({ err: error }, 'Expenses POST error:')
    return NextResponse.json({ error: 'Failed to create expense' }, { status: 500 })
  }
}
