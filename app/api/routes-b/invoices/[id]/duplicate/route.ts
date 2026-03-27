import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { generateInvoiceNumber } from '@/lib/utils'

// POST /api/routes-b/invoices/[id]/duplicate — duplicate an invoice
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = params

    const sourceInvoice = await prisma.invoice.findUnique({
      where: { id },
    })

    if (!sourceInvoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    if (sourceInvoice.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const newNumber = generateInvoiceNumber()
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || `https://${request.headers.get('host')}`
    const paymentLink = `${baseUrl}/pay/${newNumber}`

    const newInvoice = await prisma.invoice.create({
      data: {
        userId: user.id,
        invoiceNumber: newNumber,
        clientEmail: sourceInvoice.clientEmail,
        clientName: sourceInvoice.clientName,
        description: sourceInvoice.description,
        amount: sourceInvoice.amount,
        currency: sourceInvoice.currency,
        status: 'pending',
        paymentLink,
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

    return NextResponse.json(newInvoice, { status: 201 })
  } catch (error) {
    console.error('Error duplicating invoice:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}