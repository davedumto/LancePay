import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const invoice = await prisma.invoice.findFirst({
    where: {
      OR: [
        { id },
        { invoiceNumber: id },
      ],
    },
    select: {
      invoiceNumber: true,
      status: true,
      amount: true,
      currency: true,
      paidAt: true,
      dueDate: true,
    },
  })

  if (!invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  }

  return NextResponse.json({
    invoiceNumber: invoice.invoiceNumber,
    status: invoice.status,
    amount: Number(invoice.amount),
    currency: invoice.currency,
    paidAt: invoice.paidAt,
    dueDate: invoice.dueDate,
  })
}
