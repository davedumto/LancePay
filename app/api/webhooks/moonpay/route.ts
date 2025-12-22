import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { sendPaymentReceivedEmail } from '@/lib/email'

export async function POST(request: NextRequest) {
  try {
    const event = await request.json()
    console.log('MoonPay webhook:', event.type)

    if (event.type !== 'transaction_completed' && event.data?.status !== 'completed') {
      return NextResponse.json({ received: true })
    }

    const invoiceNumber = event.data?.externalTransactionId
    if (!invoiceNumber) return NextResponse.json({ received: true })

    const invoice = await prisma.invoice.findUnique({
      where: { invoiceNumber },
      include: { user: true }
    })

    if (!invoice || invoice.status === 'paid') return NextResponse.json({ received: true })

    await prisma.$transaction([
      prisma.invoice.update({
        where: { id: invoice.id },
        data: { status: 'paid', paidAt: new Date() }
      }),
      prisma.transaction.create({
        data: {
          userId: invoice.userId,
          type: 'payment',
          status: 'completed',
          amount: invoice.amount,
          currency: invoice.currency,
          invoiceId: invoice.id,
          completedAt: new Date(),
        }
      })
    ])

    if (invoice.user.email) {
      await sendPaymentReceivedEmail({
        to: invoice.user.email,
        freelancerName: invoice.user.name || 'Freelancer',
        clientName: invoice.clientName || 'Client',
        invoiceNumber: invoice.invoiceNumber,
        amount: Number(invoice.amount),
        currency: invoice.currency,
      })
    }

    return NextResponse.json({ received: true })
  } catch (error) {
    console.error('MoonPay webhook error:', error)
    return NextResponse.json({ received: true })
  }
}
