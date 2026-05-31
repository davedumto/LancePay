import { withRequestId } from '../../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const REFUND_EVENT_TYPE = 'invoice.refunded'
const MAX_REASON_LENGTH = 500

function toCents(amount: number) {
  return Math.round(amount * 100)
}

function fromCents(cents: number) {
  return cents / 100
}

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

  const invoice = await prisma.invoice.findUnique({
    where: { id },
    select: { id: true, userId: true, status: true, amount: true, currency: true },
  })

  if (!invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  }
  if (invoice.userId !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  if (invoice.status !== 'paid') {
    return NextResponse.json(
      { error: 'Only paid invoices can be refunded', code: 'INVOICE_NOT_PAID' },
      { status: 422 },
    )
  }

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { amount, reason } = body as { amount?: unknown; reason?: unknown }

  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ error: 'amount must be a positive number' }, { status: 400 })
  }
  if (typeof reason !== 'string' || reason.trim() === '') {
    return NextResponse.json({ error: 'reason must be a non-empty string' }, { status: 400 })
  }
  if (reason.length > MAX_REASON_LENGTH) {
    return NextResponse.json(
      { error: `reason must be ${MAX_REASON_LENGTH} characters or fewer` },
      { status: 400 },
    )
  }

  const amountCents = toCents(amount)
  if (amountCents <= 0) {
    return NextResponse.json({ error: 'amount must be at least 0.01' }, { status: 400 })
  }

  const priorRefunds = await prisma.auditEvent.findMany({
    where: { invoiceId: invoice.id, eventType: REFUND_EVENT_TYPE },
    select: { metadata: true },
  })

  const totalAlreadyRefundedCents = priorRefunds.reduce((sum, ev) => {
    const meta = ev.metadata as { amount?: number } | null
    return sum + (typeof meta?.amount === 'number' ? toCents(meta.amount) : 0)
  }, 0)

  const invoiceTotalCents = toCents(Number(invoice.amount))
  const remainingCents = invoiceTotalCents - totalAlreadyRefundedCents

  if (amountCents > remainingCents) {
    return NextResponse.json(
      {
        error: 'Refund amount exceeds remaining refundable',
        code: 'REFUND_EXCEEDS_REMAINING',
        remainingRefundable: fromCents(remainingCents),
      },
      { status: 422 },
    )
  }

  const newTotalRefundedCents = totalAlreadyRefundedCents + amountCents
  const normalizedAmount = fromCents(amountCents)
  const trimmedReason = reason.trim()

  const event = await prisma.auditEvent.create({
    data: {
      invoiceId: invoice.id,
      eventType: REFUND_EVENT_TYPE,
      actorId: user.id,
      metadata: {
        amount: normalizedAmount,
        currency: invoice.currency,
        reason: trimmedReason,
        cumulativeRefundedAfter: fromCents(newTotalRefundedCents),
      } as Record<string, unknown>,
      signature: 'system-refund',
    },
  })

  return NextResponse.json(
    {
      refund: {
        id: event.id,
        invoiceId: invoice.id,
        amount: normalizedAmount,
        currency: invoice.currency,
        reason: trimmedReason,
        refundedAt: event.createdAt,
      },
      totalRefunded: fromCents(newTotalRefundedCents),
      remainingRefundable: fromCents(invoiceTotalCents - newTotalRefundedCents),
    },
    { status: 201 },
  )
}

export const POST = withRequestId(POSTHandler)
