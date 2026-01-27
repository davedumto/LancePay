import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { sendPaymentReceivedEmail } from '@/lib/email'
import { createReferralEarning } from '@/lib/referral'
import { processAutoSwap } from '@/lib/auto-swap'
import { dispatchWebhooks } from '@/lib/webhooks'

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
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            referredById: true
          }
        }
      }
    })

    if (!invoice || invoice.status === 'paid') return NextResponse.json({ received: true })

    // Mark invoice as paid and create payment transaction
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

    if (invoice.user.referredById) {
      await createReferralEarning({
        referrerId: invoice.user.referredById,
        referredUserId: invoice.userId,
        invoiceId: invoice.id,
        invoiceAmount: Number(invoice.amount)
      })
    }

    if (invoice.user.email) {
      await sendPaymentReceivedEmail({
        to: invoice.user.email,
        freelancerName: invoice.user.name || 'Freelancer',
        clientName: invoice.clientName || 'Client',
        invoiceNumber: invoice.invoiceNumber,
        amount: Number(invoice.amount),
        currency: invoice.currency,
    const paymentAmount = Number(invoice.amount)

    // Process auto-swap if user has an active rule
    const autoSwapResult = await processAutoSwap(
      invoice.userId,
      paymentAmount,
      invoice.user.email,
      invoice.user.name || undefined
    )

    if (autoSwapResult.triggered) {
      console.log('Auto-swap triggered for user:', invoice.userId, {
        swapAmount: autoSwapResult.swapAmount,
        remainingAmount: autoSwapResult.remainingAmount,
        bankAccountId: autoSwapResult.bankAccountId,
      })
      // Auto-swap notification is handled within processAutoSwap
    } else {
      // No auto-swap - send regular payment notification
      if (invoice.user.email) {
        await sendPaymentReceivedEmail({
          to: invoice.user.email,
          freelancerName: invoice.user.name || 'Freelancer',
          clientName: invoice.clientName || 'Client',
          invoiceNumber: invoice.invoiceNumber,
          amount: paymentAmount,
          currency: invoice.currency,
        })
      }
    }

    // Dispatch webhook for invoice.paid event
    await dispatchWebhooks(invoice.userId, 'invoice.paid', {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      amount: paymentAmount,
      currency: invoice.currency,
      clientEmail: invoice.clientEmail,
      clientName: invoice.clientName,
      paidAt: new Date().toISOString(),
    })

    return NextResponse.json({ received: true })
  } catch (error) {
    console.error('MoonPay webhook error:', error)
    return NextResponse.json({ received: true })
  }
}
