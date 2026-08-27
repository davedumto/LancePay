import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// POST /api/routes-b/invoices/[id]/apply-retainer — apply retainer credit to an invoice

const BLOCKED_STATUSES = new Set(['paid', 'cancelled'])

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const payload = (body ?? {}) as Record<string, unknown>
    const { subscriptionId, amount } = payload

    if (typeof subscriptionId !== 'string' || !subscriptionId.trim()) {
      return NextResponse.json({ error: 'subscriptionId is required' }, { status: 400 })
    }

    if (amount !== undefined) {
      const parsedAmount = Number(amount)
      if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        return NextResponse.json(
          { error: 'amount must be a positive number when provided' },
          { status: 400 },
        )
      }
    }

    const invoice = await prisma.invoice.findFirst({
      where: { id, userId: user.id },
      select: {
        id: true,
        amount: true,
        currency: true,
        status: true,
        clientEmail: true,
        subscriptionId: true,
      },
    })

    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })

    if (BLOCKED_STATUSES.has(invoice.status)) {
      return NextResponse.json(
        { error: `Cannot apply retainer credit to a ${invoice.status} invoice` },
        { status: 422 },
      )
    }

    if (invoice.subscriptionId) {
      return NextResponse.json(
        { error: 'A retainer is already applied to this invoice' },
        { status: 409 },
      )
    }

    const subscription = await prisma.subscription.findFirst({
      where: { id: subscriptionId, userId: user.id },
    })

    if (!subscription) {
      return NextResponse.json({ error: 'Retainer subscription not found' }, { status: 404 })
    }

    if (subscription.status !== 'active') {
      return NextResponse.json(
        { error: 'Retainer subscription must be active' },
        { status: 422 },
      )
    }

    if (
      subscription.clientEmail.toLowerCase() !== invoice.clientEmail.toLowerCase()
    ) {
      return NextResponse.json(
        { error: 'Retainer subscription client must match the invoice client' },
        { status: 422 },
      )
    }

    const invoiceAmount = Number(invoice.amount)
    const retainerAmount = Number(subscription.amount)
    const requestedCredit =
      amount !== undefined ? Number(amount) : Math.min(retainerAmount, invoiceAmount)

    if (requestedCredit > retainerAmount) {
      return NextResponse.json(
        { error: 'Credit amount cannot exceed retainer balance' },
        { status: 400 },
      )
    }

    if (requestedCredit > invoiceAmount) {
      return NextResponse.json(
        { error: 'Credit amount cannot exceed invoice amount' },
        { status: 400 },
      )
    }

    const newAmount = Math.round((invoiceAmount - requestedCredit) * 100) / 100

    const updatedInvoice = await prisma.invoice.update({
      where: { id },
      data: {
        subscriptionId: subscription.id,
        amount: newAmount,
      },
      select: {
        id: true,
        amount: true,
        currency: true,
        status: true,
        subscriptionId: true,
      },
    })

    return NextResponse.json({
      invoiceId: updatedInvoice.id,
      subscriptionId: subscription.id,
      creditApplied: requestedCredit,
      previousAmount: invoiceAmount,
      newAmount: Number(updatedInvoice.amount),
      currency: updatedInvoice.currency,
      status: updatedInvoice.status,
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-b/invoices/[id]/apply-retainer error')
    return NextResponse.json({ error: 'Failed to apply retainer credit' }, { status: 500 })
  }
}
