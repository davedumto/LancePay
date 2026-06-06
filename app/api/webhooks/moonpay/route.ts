import crypto from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { sendPaymentReceivedEmail } from '@/lib/email'
import { logger } from '@/lib/logger'

function verifyMoonPaySignature(rawBody: string, signature: string, secret: string): boolean {
  if (!signature || !secret) return false
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('base64')
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  } catch {
    return false // handles length mismatch
  }
}

export async function POST(request: NextRequest) {
  try {
    // Step 1: Read raw body and verify webhook signature
    const rawBody = await request.text()
    const signature = request.headers.get('moonpay-signature') ?? ''
    const secret = process.env.MOONPAY_WEBHOOK_KEY ?? ''

    if (!verifyMoonPaySignature(rawBody, signature, secret)) {
      console.warn('MoonPay webhook: invalid signature')
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }

    // Step 2: Parse the verified body
    let event: any
    try {
      event = JSON.parse(rawBody)
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    logger.info({ eventType: event.type }, 'MoonPay webhook')

    if (
      event.type !== 'transaction_completed' &&
      event.data?.status !== 'completed'
    ) {
      return NextResponse.json({ received: true })
    }

    const invoiceNumber = event.data?.externalTransactionId
    if (!invoiceNumber) return NextResponse.json({ received: true })

    const invoice = await prisma.invoice.findUnique({
      where: { invoiceNumber },
      include: {
        user: {
          select: { id: true, email: true, name: true },
        },
      },
    })

    if (!invoice || invoice.status === 'paid')
      return NextResponse.json({ received: true })

    const settled = await prisma.$transaction(async (tx: any) => {
      const now = new Date()

      const updateResult = await tx.invoice.updateMany({
        where: { id: invoice.id, status: 'pending' },
        data: { status: 'paid', paidAt: now },
      })

      if (updateResult.count === 0) return false

      await tx.transaction.create({
        data: {
          userId: invoice.userId,
          type: 'payment',
          status: 'completed',
          amount: invoice.amount,
          currency: invoice.currency,
          invoiceId: invoice.id,
          completedAt: now,
        },
      })

      return true
    })

    if (!settled) return NextResponse.json({ received: true })

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
    logger.error({ err: error }, 'MoonPay webhook error')
    return NextResponse.json({ received: true })
  }
}
