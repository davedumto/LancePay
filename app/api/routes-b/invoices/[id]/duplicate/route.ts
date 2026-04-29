import { withRequestId } from '../../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { generateInvoiceNumber } from '@/lib/utils'

async function POSTHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const sourceInvoice = await prisma.invoice.findUnique({ where: { id } })
  if (!sourceInvoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  }

  if (sourceInvoice.userId !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const invoiceNumber = generateInvoiceNumber()
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || `https://${request.headers.get('host')}`
  const paymentLink = `${baseUrl}/pay/${invoiceNumber}`

  const duplicated = await prisma.invoice.create({
    data: {
      userId: user.id,
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
    },
    select: {
      id: true,
      invoiceNumber: true,
      clientEmail: true,
      amount: true,
      status: true,
      paymentLink: true,
    },
  })

  return NextResponse.json(
    {
      ...duplicated,
      amount: Number(duplicated.amount),
    },
    { status: 201 },
  )
}

export const POST = withRequestId(POSTHandler)
