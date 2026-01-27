import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { createReferralEarning } from '@/lib/referral'
import { dispatchWebhooks } from '@/lib/webhooks'
import { logAuditEvent, extractRequestMetadata } from '@/lib/audit'
import { processSavingsOnPayment } from '@/lib/savings'

export async function GET(request: NextRequest, { params }: { params: Promise<{ invoiceId: string }> }) {
  const { invoiceId } = await params
  const invoice = await prisma.invoice.findUnique({
    where: { invoiceNumber: invoiceId },
    include: { user: { select: { name: true, wallet: { select: { address: true } } } } },
  })

  if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })

  // Log audit event for invoice view (async, non-blocking)
  logAuditEvent(invoice.id, 'invoice.viewed', null, extractRequestMetadata(request.headers)).catch((error) => {
    console.error('Failed to log invoice.viewed audit event:', error)
  })

  // Dispatch webhook for invoice.viewed event (async, non-blocking)
  dispatchWebhooks(invoice.userId, 'invoice.viewed', {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    amount: Number(invoice.amount),
    currency: invoice.currency,
    clientEmail: invoice.clientEmail,
    viewedAt: new Date().toISOString(),
  }).catch((error) => {
    console.error('Failed to dispatch invoice.viewed webhook:', error)
  })

  return NextResponse.json({
    invoiceNumber: invoice.invoiceNumber,
    freelancerName: invoice.user.name || 'Freelancer',
    description: invoice.description,
    amount: Number(invoice.amount),
    status: invoice.status,
    dueDate: invoice.dueDate,
    walletAddress: invoice.user.wallet?.address,
  })
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ invoiceId: string }> }) {
  const { invoiceId } = await params
  const invoice = await prisma.invoice.findUnique({
    where: { invoiceNumber: invoiceId },
    include: {
      user: {
        select: {
          id: true,
          referredById: true
        }
      }
    }
  })

  if (!invoice || invoice.status !== 'pending') {
    return NextResponse.json({ error: 'Invalid invoice' }, { status: 400 })
  }

  await prisma.$transaction([
    prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: 'paid', paidAt: new Date() }
    }),
    prisma.transaction.create({
      data: {
        userId: invoice.userId,
        type: 'incoming',
        status: 'completed',
        amount: invoice.amount,
        currency: invoice.currency,
        invoiceId: invoice.id,
        completedAt: new Date()
      }
    })
  ])
  const updatedInvoice = await prisma.invoice.update({
    where: { id: invoice.id },
    data: { status: 'paid', paidAt: new Date() },
    include: { user: true }
  })

  // Log audit event for payment
  await logAuditEvent(invoice.id, 'invoice.paid', null, extractRequestMetadata(request.headers))

  if (invoice.user.referredById) {
    await createReferralEarning({
      referrerId: invoice.user.referredById,
      referredUserId: invoice.user.id,
      invoiceId: invoice.id,
      invoiceAmount: Number(invoice.amount)
    })
  }

  // Process savings goals auto-deduction
  await processSavingsOnPayment(updatedInvoice.userId, Number(updatedInvoice.amount))

  // Process auto-swap
  const { processAutoSwap } = await import('@/lib/auto-swap')
  await processAutoSwap(
    updatedInvoice.userId,
    Number(updatedInvoice.amount),
    updatedInvoice.user.email,
    updatedInvoice.user.name || undefined
  )

  // Dispatch webhook for invoice.paid event
  await dispatchWebhooks(updatedInvoice.userId, 'invoice.paid', {
    invoiceId: updatedInvoice.id,
    invoiceNumber: updatedInvoice.invoiceNumber,
    amount: Number(updatedInvoice.amount),
    currency: updatedInvoice.currency,
    clientEmail: updatedInvoice.clientEmail,
    clientName: updatedInvoice.clientName,
    paidAt: new Date().toISOString(),
  })

  return NextResponse.json({ success: true })
}
