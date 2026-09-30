import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { convertAmount, findFxRate, serializeFxRate } from '@/lib/fx-rates'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: expenseId } = await params
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    let body: { invoiceId?: string }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { invoiceId } = body
    if (!invoiceId || typeof invoiceId !== 'string') {
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
      select: { id: true, currency: true, status: true },
    })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    if (invoice.status === 'paid') {
      return NextResponse.json(
        { error: 'Cannot match expense to a paid invoice' },
        { status: 422 },
      )
    }

    const historicalFx = await findFxRate(expense.currency, invoice.currency, expense.expenseDate)
    const currentFx = await findFxRate(expense.currency, invoice.currency, undefined)

    if (!historicalFx) {
      return NextResponse.json(
        { error: 'Historical FX rate not found' },
        { status: 422 },
      )
    }
    if (!currentFx) {
      return NextResponse.json(
        { error: 'Current FX rate not found' },
        { status: 422 },
      )
    }

    const atIncurred = convertAmount(expense.amount, historicalFx)
    const atCurrent = convertAmount(expense.amount, currentFx)

    const lastLineItem = await prisma.invoiceLineItem.findFirst({
      where: { invoiceId },
      orderBy: { position: 'desc' },
      select: { position: true },
    })
    const position = (lastLineItem?.position ?? -1) + 1

    const result = await prisma.$transaction(async (tx) => {
      const match = await tx.expenseReimbursementMatch.create({
        data: {
          expenseId: expense.id,
          invoiceId: invoice.id,
        },
      })

      const lineItem = await tx.invoiceLineItem.create({
        data: {
          invoiceId: invoice.id,
          description: `Reimbursement: ${expense.category} - ${expense.description}`,
          quantity: 1,
          unitPrice: atIncurred,
          position,
        },
      })

      await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          amount: { increment: atIncurred },
        },
      })

      return { match, lineItem }
    })

    return NextResponse.json(
      {
        match: result.match,
        lineItem: {
          ...result.lineItem,
          quantity: Number(result.lineItem.quantity),
          unitPrice: Number(result.lineItem.unitPrice),
        },
        conversion: {
          historicalRate: serializeFxRate(historicalFx),
          currentRate: serializeFxRate(currentFx),
          delta: atCurrent.minus(atIncurred).toFixed(2),
          atIncurred: atIncurred.toFixed(2),
          atCurrent: atCurrent.toFixed(2),
        },
      },
      { status: 201 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/expenses/[id]/match-reimbursement error')
    return NextResponse.json({ error: 'Failed to match reimbursement' }, { status: 500 })
  }
}
