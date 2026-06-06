import { withRequestId, getRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { errorResponse } from '../../_lib/errors'
import { logger } from '@/lib/logger'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function transactionDescription(transaction: {
  type: string
  error: string | null
  invoice: { invoiceNumber: string } | null
}) {
  if (transaction.invoice?.invoiceNumber) {
    return `Invoice ${transaction.invoice.invoiceNumber} paid`
  }
  if (transaction.type === 'withdrawal') {
    return transaction.error ?? 'Withdrawal initiated'
  }
  return transaction.error ?? 'Transaction recorded'
}

async function GETHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = getRequestId()

  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) {
      return errorResponse('UNAUTHORIZED', 'Unauthorized', { requestId }, 401)
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return errorResponse('UNAUTHORIZED', 'Invalid token', { requestId }, 401)
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })
    if (!user) {
      return errorResponse('NOT_FOUND', 'User not found', { requestId }, 404)
    }

    const { id } = await params
    if (!id?.trim()) {
      return errorResponse(
        'BAD_REQUEST',
        'Invalid transaction id',
        { fields: { id: 'Transaction id is required' }, requestId },
        400,
      )
    }

    if (!UUID_PATTERN.test(id)) {
      return errorResponse(
        'BAD_REQUEST',
        'Invalid transaction id',
        { fields: { id: 'Must be a valid UUID' }, requestId },
        400,
      )
    }

    const transaction = await prisma.transaction.findUnique({
      where: { id },
      include: {
        invoice: {
          select: { invoiceNumber: true },
        },
      },
    })

    if (!transaction || transaction.userId !== user.id) {
      return errorResponse('NOT_FOUND', 'Transaction not found', { requestId }, 404)
    }

    return NextResponse.json({
      transaction: {
        id: transaction.id,
        type: transaction.type,
        status: transaction.status,
        amount: Number(transaction.amount),
        currency: transaction.currency,
        description: transactionDescription(transaction),
        stellarTxHash: transaction.txHash ?? null,
        createdAt: transaction.createdAt,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'Routes-B transactions/[id] GET error')
    return errorResponse(
      'INTERNAL',
      'Failed to fetch transaction',
      { requestId },
      500,
    )
  }
}

export const GET = withRequestId(GETHandler)
