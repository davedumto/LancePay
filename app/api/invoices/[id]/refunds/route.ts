import { NextRequest, NextResponse } from 'next/server'
import { Decimal } from '@prisma/client/runtime/library'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { parsePositiveMoney } from '@/lib/money'

async function authenticate(request: NextRequest) {
  const token = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const claims = await verifyAuthToken(token)
  if (!claims) return { error: NextResponse.json({ error: 'Invalid token' }, { status: 401 }) }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) return { error: NextResponse.json({ error: 'User not found' }, { status: 404 }) }
  return { user }
}

function serializeRefund(refund: {
  id: string
  invoiceId: string
  amount: { toNumber(): number }
  currency: string
  reason: string
  status: string
  createdAt: Date
}) {
  return { ...refund, amount: refund.amount.toNumber(), createdAt: refund.createdAt.toISOString() }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: invoiceId } = await params
    const auth = await authenticate(request)
    if (auth.error) return auth.error

    const invoice = await prisma.invoice.findFirst({
      where: { id: invoiceId, userId: auth.user!.id },
      select: { id: true },
    })
    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })

    const refunds = await prisma.refund.findMany({
      where: { invoiceId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, invoiceId: true, amount: true, currency: true, reason: true, status: true, createdAt: true },
    })
    return NextResponse.json({ refunds: refunds.map(serializeRefund) })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/invoices/[id]/refunds error')
    return NextResponse.json({ error: 'Failed to fetch refunds' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: invoiceId } = await params
    const auth = await authenticate(request)
    if (auth.error) return auth.error

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const payload = (body ?? {}) as Record<string, unknown>
    const amount = parsePositiveMoney(payload.amount)
    if (!amount) {
      return NextResponse.json({ error: 'amount must be a positive amount with at most 2 decimal places' }, { status: 400 })
    }
    if (typeof payload.reason !== 'string' || !payload.reason.trim()) {
      return NextResponse.json({ error: 'reason is required' }, { status: 400 })
    }

    const invoice = await prisma.invoice.findFirst({
      where: { id: invoiceId, userId: auth.user!.id },
      select: {
        id: true,
        currency: true,
        transaction: { select: { amount: true, status: true } },
        manualPayments: {
          where: { status: { in: ['verified', 'reconciled'] } },
          select: { amountPaid: true },
        },
      },
    })
    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })

    const zero = new Decimal(0)
    const paidFromTransaction = invoice.transaction?.status === 'completed'
      ? invoice.transaction.amount
      : zero
    const paidFromManualPayments = invoice.manualPayments.reduce(
      (total, payment) => total.plus(payment.amountPaid),
      zero,
    )
    const paidAmount = paidFromTransaction.plus(paidFromManualPayments)
    const result = await prisma.$transaction(async (tx) => {
      const existingRefunds = await tx.refund.aggregate({
        where: { invoiceId, status: { in: ['pending', 'completed'] } },
        _sum: { amount: true },
      })
      const alreadyRefunded = existingRefunds._sum.amount ?? zero
      const remaining = paidAmount.minus(alreadyRefunded)

      if (amount.gt(remaining)) return { error: true as const, remaining }

      const refund = await tx.refund.create({
        data: {
          userId: auth.user!.id,
          invoiceId,
          amount,
          currency: invoice.currency,
          reason: payload.reason.trim(),
          status: 'pending',
        },
        select: { id: true, invoiceId: true, amount: true, currency: true, reason: true, status: true, createdAt: true },
      })
      return { error: false as const, refund }
    }, { isolationLevel: 'Serializable' })

    if (result.error) {
      return NextResponse.json(
        { error: 'amount exceeds the amount paid and not already refunded', remainingRefundable: Math.max(0, result.remaining.toNumber()) },
        { status: 400 },
      )
    }

    return NextResponse.json({ refund: serializeRefund(result.refund) }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/invoices/[id]/refunds error')
    return NextResponse.json({ error: 'Failed to issue refund' }, { status: 500 })
  }
}