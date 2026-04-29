import { withRequestId } from '../../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { createCreditNote } from '../../../_lib/credit-notes'
import { registerRoute } from '../../../_lib/openapi'
import { z } from 'zod'

registerRoute({
  method: 'POST',
  path: '/transactions/{id}/refund',
  summary: 'Refund a transaction',
  description: 'Refund a payment transaction and auto-create a credit note.',
  requestSchema: z.object({
    id: z.string().describe('Transaction ID'),
    amount: z.number().positive().optional().describe('Partial refund amount. Defaults to full.'),
    reason: z.string().describe('Reason for refund')
  }),
  responseSchema: z.object({
    id: z.string(),
    status: z.string(),
    creditNoteNumber: z.string()
  }),
  tags: ['transactions']
})

async function POSTHandler(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = params
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const transaction = await prisma.transaction.findUnique({
      where: { id, userId: user.id },
      include: { invoice: true }
    })

    if (!transaction) return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
    if (transaction.type !== 'payment') return NextResponse.json({ error: 'Only payments can be refunded' }, { status: 400 })

    const body = await request.json()
    const refundAmount = body.amount || Number(transaction.amount)
    const reason = body.reason

    if (refundAmount > Number(transaction.amount)) {
      return NextResponse.json({ error: 'Refund amount exceeds transaction amount' }, { status: 400 })
    }

    // Atomic operation (using Prisma transaction + our helper)
    const result = await prisma.$transaction(async (tx) => {
      // Update transaction status
      const updatedTx = await tx.transaction.update({
        where: { id },
        data: { status: 'refunded' }
      })

      // Update invoice if exists
      if (transaction.invoiceId) {
        await tx.invoice.update({
          where: { id: transaction.invoiceId },
          data: { status: 'refunded' }
        })
      }

      // Create credit note
      const note = await createCreditNote(user.id, {
        invoiceId: transaction.invoiceId || 'N/A',
        amount: refundAmount,
        currency: transaction.currency,
        reason
      })

      return { updatedTx, note }
    })

    return NextResponse.json({
      id: result.updatedTx.id,
      status: result.updatedTx.status,
      creditNoteNumber: result.note.number
    })
  } catch (error) {
    return NextResponse.json({ error: 'Failed to process refund' }, { status: 500 })
  }
}

export const POST = withRequestId(POSTHandler)
