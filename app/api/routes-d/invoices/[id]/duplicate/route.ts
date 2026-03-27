import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { generateInvoiceNumber } from '@/lib/utils'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const originalInvoice = await prisma.invoice.findUnique({
    where: { id },
  })

  if (!originalInvoice) {
    return NextResponse.json({ error: 'Original invoice not found' }, { status: 404 })
  }

  if (originalInvoice.userId !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const invoiceNumber = generateInvoiceNumber()
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || `https://${request.headers.get('host')}`
  const paymentLink = `${baseUrl}/pay/${invoiceNumber}`

  const newInvoice = await prisma.invoice.create({
    data: {
      userId: user.id,
      invoiceNumber,
      paymentLink,
      clientEmail: originalInvoice.clientEmail,
      clientName: originalInvoice.clientName,
      description: originalInvoice.description,
      amount: originalInvoice.amount,
      currency: originalInvoice.currency,
      status: 'pending',
      dueDate: null,
      paidAt: null,
    },
  })

  return NextResponse.json(newInvoice, { status: 201 })
}
