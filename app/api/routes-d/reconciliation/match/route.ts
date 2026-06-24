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

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = (await request.json().catch(() => null)) as { transactionId?: string; invoiceId?: string } | null
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

    const { transactionId, invoiceId } = body
    if (!transactionId || typeof transactionId !== 'string') {
      return NextResponse.json({ error: 'transactionId is required' }, { status: 400 })
    }
    if (!invoiceId || typeof invoiceId !== 'string') {
      return NextResponse.json({ error: 'invoiceId is required' }, { status: 400 })
    }

    // 1. Fetch transaction and check ownership
    const transaction = await prisma.transaction.findUnique({
      where: { id: transactionId },
    })
    if (!transaction) {
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
    }
    if (transaction.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // 2. Fetch invoice and check ownership
    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
    })
    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }
    if (invoice.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // 3. Check if transaction is already matched to another invoice
    if (transaction.invoiceId) {
      return NextResponse.json(
        { error: `Transaction is already matched to invoice ${transaction.invoiceId}` },
        { status: 409 },
      )
    }

    // 4. Check if invoice is already matched to another transaction
    const existingMatch = await prisma.transaction.findFirst({
      where: { invoiceId },
    })
    if (existingMatch) {
      return NextResponse.json(
        { error: `Invoice is already matched to transaction ${existingMatch.id}` },
        { status: 409 },
      )
    }

    // 5. Update transaction and optionally invoice status
    const [updatedTransaction, updatedInvoice] = await prisma.$transaction([
      prisma.transaction.update({
        where: { id: transactionId },
        data: { invoiceId },
      }),
      prisma.invoice.update({
        where: { id: invoiceId },
        data: {
          status: transaction.status === 'completed' ? 'paid' : invoice.status,
          paidAt: transaction.status === 'completed' ? (transaction.completedAt ?? new Date()) : invoice.paidAt,
        },
      }),
    ])

    return NextResponse.json({
      success: true,
      transaction: updatedTransaction,
      invoice: updatedInvoice,
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-d/reconciliation/match error')
    return NextResponse.json({ error: 'Failed to match transaction to invoice' }, { status: 500 })
  }
}
