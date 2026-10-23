import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

/**
 * GET /api/expenses/[id]/reimbursement-match
 * Get the reimbursement match for an expense.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: expenseId } = await params
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    if (!expenseId || !expenseId.trim()) {
      return NextResponse.json({ error: 'Expense ID is required' }, { status: 400 })
    }

    const expense = await prisma.expense.findFirst({
      where: { id: expenseId, userId: user.id },
      include: {
        reimbursementMatch: {
          include: {
            invoice: {
              select: {
                id: true,
                invoiceNumber: true,
                clientEmail: true,
                amount: true,
                currency: true,
                status: true,
              },
            },
          },
        },
      },
    })

    if (!expense) {
      return NextResponse.json({ error: 'Expense not found' }, { status: 404 })
    }

    if (!expense.reimbursementMatch) {
      return NextResponse.json({ error: 'No reimbursement match found' }, { status: 404 })
    }

    return NextResponse.json({
      match: {
        id: expense.reimbursementMatch.id,
        expenseId: expense.reimbursementMatch.expenseId,
        invoiceId: expense.reimbursementMatch.invoiceId,
        createdAt: expense.reimbursementMatch.createdAt.toISOString(),
      },
      expense: {
        id: expense.id,
        category: expense.category,
        description: expense.description,
        amount: Number(expense.amount),
        currency: expense.currency,
        expenseDate: expense.expenseDate.toISOString(),
      },
      invoice: {
        ...expense.reimbursementMatch.invoice,
        amount: Number(expense.reimbursementMatch.invoice.amount),
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/expenses/[id]/reimbursement-match error')
    return NextResponse.json({ error: 'Failed to fetch reimbursement match' }, { status: 500 })
  }
}

/**
 * POST /api/expenses/[id]/reimbursement-match
 * Link an expense to an invoice for reimbursement.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: expenseId } = await params
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    if (!expenseId || !expenseId.trim()) {
      return NextResponse.json({ error: 'Expense ID is required' }, { status: 400 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const payload = (body ?? {}) as Record<string, unknown>
    const { invoiceId } = payload

    if (typeof invoiceId !== 'string' || !invoiceId.trim()) {
      return NextResponse.json({ error: 'invoiceId is required' }, { status: 400 })
    }

    const expense = await prisma.expense.findFirst({
      where: { id: expenseId, userId: user.id },
      include: { reimbursementMatch: true },
    })

    if (!expense) {
      return NextResponse.json({ error: 'Expense not found' }, { status: 404 })
    }

    if (expense.reimbursementMatch) {
      return NextResponse.json(
        { error: 'Expense is already matched to an invoice' },
        { status: 409 },
      )
    }

    const invoice = await prisma.invoice.findFirst({
      where: { id: invoiceId, userId: user.id },
      select: {
        id: true,
        invoiceNumber: true,
        clientEmail: true,
        amount: true,
        currency: true,
        status: true,
      },
    })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    const match = await prisma.expenseReimbursementMatch.create({
      data: {
        expenseId: expense.id,
        invoiceId: invoice.id,
      },
    })

    return NextResponse.json(
      {
        match: {
          id: match.id,
          expenseId: match.expenseId,
          invoiceId: match.invoiceId,
          createdAt: match.createdAt.toISOString(),
        },
        expense: {
          id: expense.id,
          category: expense.category,
          description: expense.description,
          amount: Number(expense.amount),
          currency: expense.currency,
          expenseDate: expense.expenseDate.toISOString(),
        },
        invoice: {
          ...invoice,
          amount: Number(invoice.amount),
        },
      },
      { status: 201 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/expenses/[id]/reimbursement-match error')
    return NextResponse.json({ error: 'Failed to create reimbursement match' }, { status: 500 })
  }
}
