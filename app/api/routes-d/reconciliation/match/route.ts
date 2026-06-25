import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { logger } from '../../_shared/logger'
import { getAuthenticatedUser } from '../../_shared/auth'

const MatchSchema = z.object({
  transactionId: z.string().trim().min(1),
  invoiceId: z.string().trim().min(1),
})

type TransactionRecord = {
  id: string
  userId: string
  invoiceId: string | null
  status: string
  completedAt: Date | null
}

type InvoiceRecord = {
  id: string
  userId: string
  transaction: { id: string } | null
  status: string
  paidAt: Date | null
}

type TransactionDelegate = {
  findUnique: (args: Record<string, unknown>) => Promise<TransactionRecord | null>
  update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

type InvoiceDelegate = {
  findUnique: (args: Record<string, unknown>) => Promise<InvoiceRecord | null>
  update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

function getTransactionDelegate(): TransactionDelegate {
  return (prisma as unknown as { transaction: TransactionDelegate }).transaction
}

function getInvoiceDelegate(): InvoiceDelegate {
  return (prisma as unknown as { invoice: InvoiceDelegate }).invoice
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      body = {}
    }

    const parsed = MatchSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.format() },
        { status: 400 },
      )
    }

    const { transactionId, invoiceId } = parsed.data
    const transaction = await getTransactionDelegate().findUnique({
      where: { id: transactionId },
      select: {
        id: true,
        userId: true,
        invoiceId: true,
        status: true,
        completedAt: true,
      },
    })
    if (!transaction || transaction.userId !== user.id) {
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
    }

    const invoice = await getInvoiceDelegate().findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        userId: true,
        transaction: { select: { id: true } },
        status: true,
        paidAt: true,
      },
    })
    if (!invoice || invoice.userId !== user.id) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    if (transaction.invoiceId && transaction.invoiceId !== invoice.id) {
      return NextResponse.json({ error: 'Transaction is already matched to another invoice' }, { status: 409 })
    }
    if (invoice.transaction && invoice.transaction.id !== transaction.id) {
      return NextResponse.json({ error: 'Invoice is already matched to another transaction' }, { status: 409 })
    }

    const matchedAt = new Date()
    await prisma.$transaction(async (tx) => {
      await tx.transaction.update({
        where: { id: transaction.id },
        data: {
          invoiceId: invoice.id,
          status: 'completed',
          completedAt: transaction.completedAt ?? matchedAt,
        },
      })

      await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          status: 'paid',
          paidAt: invoice.paidAt ?? matchedAt,
        },
      })
    })

    return NextResponse.json({
      match: {
        transactionId: transaction.id,
        invoiceId: invoice.id,
        matchedAt: matchedAt.toISOString(),
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-d/reconciliation/match error')
    return NextResponse.json({ error: 'Failed to match transaction to invoice' }, { status: 500 })
  }
}
