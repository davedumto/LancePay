import { withRequestId } from '../../../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { sendInvoiceToClient } from '@/lib/email'

async function POSTHandler(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const { id } = await context.params

  const invoice = await prisma.invoice.findFirst({
    where: { id, userId: user.id },
  })
  
  if (!invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  }

  try {
    const result = await sendInvoiceToClient({
      clientEmail: invoice.clientEmail,
      clientName: invoice.clientName,
      freelancerName: user.name || user.email || 'Freelancer',
      invoiceNumber: invoice.invoiceNumber,
      amount: Number(invoice.amount),
      currency: invoice.currency,
      dueDate: invoice.dueDate ? invoice.dueDate.toISOString() : null,
      paymentLink: invoice.paymentLink,
    })

    if (result && 'skipped' in result && result.skipped) {
       return NextResponse.json({ error: 'Invalid client email' }, { status: 422 })
    }
  } catch (error) {
    logger.error({ error, invoiceId: id }, 'Failed to send invoice email')
    return NextResponse.json({ error: 'Failed to send email' }, { status: 500 })
  }

  logger.info({ userId: user.id, invoiceId: id }, 'Invoice emailed to client')

  return NextResponse.json({
    id: invoice.id,
    emailSent: true
  })
}

export const POST = withRequestId(POSTHandler)
