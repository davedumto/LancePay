import { withRequestId } from '../../../_lib/with-request-id'
import { withMethods } from '../../../_lib/with-methods'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { sendEmail } from '@/lib/email'
import { errorResponse } from '../../../_lib/errors'
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
  { params }: { params: Promise<{ id: string }> }
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

    const invoice = await prisma.invoice.findUnique({
      where: { id: parsedParams.data.id },
      select: {
        id: true,
        userId: true,
        status: true,
        clientEmail: true,
        invoiceNumber: true,
        amount: true,
        currency: true,
        dueDate: true,
        paymentLink: true,
      },
    })

    if (!invoice || invoice.userId !== auth.user.id) {
      return errorResponse('NOT_FOUND', 'Invoice not found', undefined, 404)
    }

    if (invoice.status !== 'pending') {
      return errorResponse(
        'BAD_REQUEST',
        'Reminders can only be sent for pending invoices',
        undefined,
        422,
      )
    }

    const dueDateStr = invoice.dueDate
      ? new Date(invoice.dueDate).toLocaleDateString()
      : 'Not set'
    const amountStr = Number(invoice.amount).toFixed(2)
    
    await sendEmail({
      to: invoice.clientEmail,
      subject: `Payment reminder: ${invoice.invoiceNumber}`,
      html: `
        <div style="font-family: system-ui, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px;">
          <h2>Payment reminder</h2>
          <p>This is a friendly reminder about invoice <strong>${invoice.invoiceNumber}</strong>.</p>
          <p><strong>Amount owed:</strong> ${amountStr} ${invoice.currency}</p>
          <p><strong>Due date:</strong> ${dueDateStr}</p>
          <p><a href="${invoice.paymentLink}" style="display: inline-block; background: #10b981; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold;">Pay now</a></p>
          <p style="color: #666; font-size: 12px; margin-top: 20px;">LancePay - Get paid globally, withdraw locally</p>
        </div>
      `,
    })

    return NextResponse.json({
      sent: true,
      invoiceId: invoice.id,
      clientEmail: invoice.clientEmail,
      invoiceNumber: invoice.invoiceNumber,
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-b/invoices/[id]/remind error')
    return errorResponse('INTERNAL', 'Failed to send invoice reminder', undefined, 500)
  }
}

export const { POST } = withMethods({
  POST: withRequestId(POSTHandler),
})
