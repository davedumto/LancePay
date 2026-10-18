import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

type RouteContext = {
  params: Promise<{ id: string }> | { id: string }
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002'
  )
}

async function resolveExpenseId(context?: RouteContext): Promise<string> {
  if (!context?.params) return ''
  const resolved = await Promise.resolve(context.params)
  return (resolved?.id ?? '').trim()
}

async function resolveAuthenticatedUser(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: 'Unauthorized', status: 401 as const, user: null }
  }
  const token = authHeader.slice(7).trim()
  if (!token) {
    return { error: 'Unauthorized', status: 401 as const, user: null }
  }

  const claims = await verifyAuthToken(token)
  if (!claims) {
    return { error: 'Unauthorized', status: 401 as const, user: null }
  }

  let userId = claims.userId
  if (typeof prisma.user?.findUnique === 'function') {
    const dbUser =
      (await prisma.user.findUnique({
        where: { privyId: claims.userId },
        select: { id: true },
      })) ??
      (await prisma.user.findUnique({
        where: { id: claims.userId },
        select: { id: true },
      }))

    if (!dbUser) {
      return { error: 'User not found', status: 404 as const, user: null }
    }
    userId = dbUser.id
  }

  return { error: null, status: 200 as const, user: { id: userId } }
}

function formatExpenseSummary(expense: Record<string, any>) {
  return {
    id: expense.id,
    userId: expense.userId,
    category: expense.category ?? null,
    description: expense.description ?? null,
    amount:
      expense.amount !== undefined && expense.amount !== null
        ? String(expense.amount)
        : '0',
    currency: expense.currency ?? 'USDC',
    expenseDate: expense.expenseDate
      ? new Date(expense.expenseDate).toISOString()
      : null,
  }
}

function formatInvoiceSummary(invoice: Record<string, any>) {
  return {
    id: invoice.id,
    userId: invoice.userId,
    invoiceNumber: invoice.invoiceNumber ?? null,
    clientName: invoice.clientName ?? null,
    clientEmail: invoice.clientEmail ?? null,
    amount:
      invoice.amount !== undefined && invoice.amount !== null
        ? String(invoice.amount)
        : '0',
    currency: invoice.currency ?? 'USDC',
    status: invoice.status ?? 'pending',
  }
}

/**
 * GET /api/expenses/[id]/reimbursement-match
 * Fetches the reimbursement match for an expense along with expense and invoice summaries.
 */
export async function GET(req: NextRequest, context: RouteContext) {
  try {
    const auth = await resolveAuthenticatedUser(req)
    if (auth.error || !auth.user) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const expenseId = await resolveExpenseId(context)
    if (!expenseId) {
      return NextResponse.json(
        { error: 'Expense ID is required' },
        { status: 400 },
      )
    }

    const expense = await prisma.expense.findUnique({
      where: { id: expenseId },
      include: {
        reimbursementMatch: {
          include: { invoice: true },
        },
      },
    })

    if (!expense) {
      return NextResponse.json(
        { error: 'Expense not found', code: 'EXPENSE_NOT_FOUND' },
        { status: 404 },
      )
    }

    if (expense.userId !== auth.user.id) {
      return NextResponse.json(
        {
          error: 'Forbidden: expense belongs to another user',
          code: 'FORBIDDEN_EXPENSE_OWNER',
        },
        { status: 403 },
      )
    }

    const matchRecord =
      expense.reimbursementMatch ??
      (typeof prisma.expenseReimbursementMatch?.findUnique === 'function'
        ? await prisma.expenseReimbursementMatch.findUnique({
            where: { expenseId: expense.id },
            include: { invoice: true },
          })
        : null)

    if (!matchRecord) {
      return NextResponse.json(
        {
          error: 'Expense has not been matched to an invoice yet',
          code: 'REIMBURSEMENT_MATCH_NOT_FOUND',
        },
        { status: 404 },
      )
    }

    const invoice =
      matchRecord.invoice ??
      (await prisma.invoice.findUnique({
        where: { id: matchRecord.invoiceId },
      }))

    return NextResponse.json({
      match: {
        id: matchRecord.id,
        expenseId: matchRecord.expenseId,
        invoiceId: matchRecord.invoiceId,
        createdAt: matchRecord.createdAt
          ? new Date(matchRecord.createdAt).toISOString()
          : null,
      },
      expense: formatExpenseSummary(expense),
      invoice: invoice ? formatInvoiceSummary(invoice) : null,
    })
  } catch (err) {
    logger?.error?.({ err }, 'GET /api/expenses/[id]/reimbursement-match error')
    return NextResponse.json(
      { error: 'Failed to fetch expense reimbursement match' },
      { status: 500 },
    )
  }
}

/**
 * POST /api/expenses/[id]/reimbursement-match
 * Links an expense to an invoice for reimbursement (`ExpenseReimbursementMatch`):
 * - Enforces the unique `expenseId` constraint, rejecting a second match attempt with a clean `409`.
 * - Validates the expense and invoice belong to the same authenticated user.
 * - Returns the match along with both the expense and invoice summary for confirmation.
 */
export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const auth = await resolveAuthenticatedUser(req)
    if (auth.error || !auth.user) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const expenseId = await resolveExpenseId(context)
    if (!expenseId) {
      return NextResponse.json(
        { error: 'Expense ID is required' },
        { status: 400 },
      )
    }

    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Invalid JSON request body' },
        { status: 400 },
      )
    }

    const invoiceId =
      typeof body.invoiceId === 'string' ? body.invoiceId.trim() : ''
    if (!invoiceId) {
      return NextResponse.json(
        {
          error: 'invoiceId is required',
          code: 'INVOICE_ID_REQUIRED',
        },
        { status: 400 },
      )
    }

    const expense = await prisma.expense.findUnique({
      where: { id: expenseId },
      include: { reimbursementMatch: true },
    })

    if (!expense) {
      return NextResponse.json(
        { error: 'Expense not found', code: 'EXPENSE_NOT_FOUND' },
        { status: 404 },
      )
    }

    if (expense.userId !== auth.user.id) {
      return NextResponse.json(
        {
          error: 'Forbidden: expense does not belong to the authenticated user',
          code: 'FORBIDDEN_EXPENSE_OWNER',
        },
        { status: 403 },
      )
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
    })

    if (!invoice) {
      return NextResponse.json(
        { error: 'Invoice not found', code: 'INVOICE_NOT_FOUND' },
        { status: 404 },
      )
    }

    if (invoice.userId !== expense.userId || invoice.userId !== auth.user.id) {
      return NextResponse.json(
        {
          error:
            'Forbidden: expense and invoice must belong to the same user',
          code: 'EXPENSE_INVOICE_USER_MISMATCH',
        },
        { status: 403 },
      )
    }

    // Enforce unique expenseId constraint (reject second match attempt with 409)
    const existingMatch =
      expense.reimbursementMatch ??
      (typeof prisma.expenseReimbursementMatch?.findUnique === 'function'
        ? await prisma.expenseReimbursementMatch.findUnique({
            where: { expenseId: expense.id },
          })
        : null)

    if (existingMatch) {
      return NextResponse.json(
        {
          error:
            'This expense is already matched to an invoice for reimbursement',
          code: 'EXPENSE_ALREADY_MATCHED',
          existingInvoiceId: existingMatch.invoiceId,
        },
        { status: 409 },
      )
    }

    let createdMatch
    try {
      createdMatch = await prisma.expenseReimbursementMatch.create({
        data: {
          expenseId: expense.id,
          invoiceId: invoice.id,
        },
      })
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return NextResponse.json(
          {
            error:
              'This expense is already matched to an invoice for reimbursement',
            code: 'EXPENSE_ALREADY_MATCHED',
          },
          { status: 409 },
        )
      }
      throw err
    }

    const expenseSummary = formatExpenseSummary(expense)
    const invoiceSummary = formatInvoiceSummary(invoice)

    return NextResponse.json(
      {
        match: {
          id: createdMatch.id,
          expenseId: createdMatch.expenseId,
          invoiceId: createdMatch.invoiceId,
          createdAt: createdMatch.createdAt
            ? new Date(createdMatch.createdAt).toISOString()
            : null,
          expense: expenseSummary,
          invoice: invoiceSummary,
        },
        expense: expenseSummary,
        invoice: invoiceSummary,
      },
      { status: 201 },
    )
  } catch (err) {
    logger?.error?.(
      { err },
      'POST /api/expenses/[id]/reimbursement-match error',
    )
    return NextResponse.json(
      { error: 'Failed to link expense to invoice for reimbursement' },
      { status: 500 },
    )
  }
}
