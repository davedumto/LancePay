import { withRequestId } from '../../../_lib/with-request-id'
import { withMethods } from '../../../_lib/with-methods'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { generateInvoiceNumber } from '@/lib/utils'
import { errorResponse } from '../../../_lib/errors'
import { emitStatsInvalidated } from '../../../_lib/events'
import { logger } from '@/lib/logger'
import { z } from 'zod'

const invoiceIdParamsSchema = z.object({
  id: z.string().uuid('Invoice id must be a valid UUID'),
})

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) {
    return { error: errorResponse('UNAUTHORIZED', 'Unauthorized', undefined, 401) }
  }

  const claims = await verifyAuthToken(authToken)
  if (!claims) {
    return { error: errorResponse('UNAUTHORIZED', 'Unauthorized', undefined, 401) }
  }

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })

  if (!user) {
    return { error: errorResponse('NOT_FOUND', 'User not found', undefined, 404) }
  }

  return { user }
}

async function POSTHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const parsedParams = invoiceIdParamsSchema.safeParse({ id })
    if (!parsedParams.success) {
      return errorResponse(
        'BAD_REQUEST',
        'Invalid invoice id',
        { fields: { id: 'Must be a valid UUID' } },
        400,
      )
    }

    const auth = await getAuthenticatedUser(request)
    if ('error' in auth) return auth.error

    const sourceInvoice = await prisma.invoice.findUnique({
      where: { id: parsedParams.data.id },
      select: {
        id: true,
        userId: true,
        clientEmail: true,
        clientName: true,
        description: true,
        amount: true,
        currency: true,
      },
    })

    if (!sourceInvoice || sourceInvoice.userId !== auth.user.id) {
      return errorResponse('NOT_FOUND', 'Invoice not found', undefined, 404)
    }

    const invoiceNumber = generateInvoiceNumber()
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || `https://${request.headers.get('host')}`
    const paymentLink = `${baseUrl}/pay/${invoiceNumber}`

    const duplicated = await prisma.invoice.create({
      data: {
        userId: auth.user.id,
        invoiceNumber,
        paymentLink,
        clientEmail: sourceInvoice.clientEmail,
        clientName: sourceInvoice.clientName,
        description: sourceInvoice.description,
        amount: sourceInvoice.amount,
        currency: sourceInvoice.currency,
        status: 'pending',
        dueDate: null,
        paidAt: null,
        cancelledAt: null,
        cancellationReason: null,
      },
      select: {
        id: true,
        invoiceNumber: true,
        clientEmail: true,
        clientName: true,
        description: true,
        amount: true,
        currency: true,
        status: true,
        paymentLink: true,
        dueDate: true,
        paidAt: true,
        createdAt: true,
      },
    })

    emitStatsInvalidated({ userId: auth.user.id })

    return NextResponse.json(
      {
        invoice: {
          ...duplicated,
          amount: Number(duplicated.amount),
        },
      },
      { status: 201 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-b/invoices/[id]/duplicate error')
    return errorResponse('INTERNAL', 'Failed to duplicate invoice', undefined, 500)
  }
}

export const { POST } = withMethods({
  POST: withRequestId(POSTHandler),
})
