import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { searchParams } = new URL(request.url)
    const invoiceId = searchParams.get('invoiceId')

    const where: any = {
      invoice: { userId: user.id },
    }
    if (invoiceId) {
      where.invoiceId = invoiceId
    }

    const manualPayments = await prisma.manualPayment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        invoice: {
          select: {
            id: true,
            invoiceNumber: true,
            amount: true,
            currency: true,
            status: true,
          },
        },
      },
    })

    return NextResponse.json({
      manualPayments: manualPayments.map((p) => ({
        ...p,
        amountPaid: p.amountPaid.toString(),
        createdAt: p.createdAt.toISOString(),
        invoice: p.invoice
          ? {
              ...p.invoice,
              amount: p.invoice.amount.toString(),
            }
          : null,
      })),
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/manual-payments error')
    return NextResponse.json({ error: 'Failed to fetch manual payments' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const {
      invoiceId,
      amountPaid,
      paymentMethod = 'bank_transfer',
      receiptUrl,
      notes,
    } = (body ?? {}) as {
      invoiceId?: string
      amountPaid?: number | string
      paymentMethod?: string
      receiptUrl?: string
      notes?: string
    }

    if (!invoiceId || typeof invoiceId !== 'string') {
      return NextResponse.json({ error: 'invoiceId is required' }, { status: 400 })
    }

    const numAmount = Number(amountPaid)
    if (!Number.isFinite(numAmount) || numAmount <= 0) {
      return NextResponse.json({ error: 'amountPaid must be a positive number' }, { status: 400 })
    }

    const invoice = await prisma.invoice.findFirst({
      where: { id: invoiceId, userId: user.id },
      select: { id: true, amount: true, currency: true, status: true },
    })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    if (invoice.status === 'paid' || invoice.status === 'cancelled' || invoice.status === 'void') {
      return NextResponse.json(
        { error: `Invoice in status ${invoice.status} cannot accept manual payments` },
        { status: 422 },
      )
    }

    // Check total payments against invoice amount
    const aggregated = await prisma.manualPayment.aggregate({
      where: { invoiceId, status: { not: 'rejected' } },
      _sum: { amountPaid: true },
    })

    const currentTotal = Number(aggregated._sum.amountPaid ?? 0)
    const invoiceTotal = Number(invoice.amount)

    if (currentTotal + numAmount > invoiceTotal) {
      return NextResponse.json(
        {
          error: `Payment amount of ${numAmount} exceeds remaining balance of ${(
            invoiceTotal - currentTotal
          ).toFixed(2)}`,
        },
        { status: 400 },
      )
    }

    const payment = await prisma.manualPayment.create({
      data: {
        invoiceId,
        amountPaid: numAmount,
        currency: invoice.currency,
        paymentMethod: typeof paymentMethod === 'string' ? paymentMethod : 'bank_transfer',
        receiptUrl: typeof receiptUrl === 'string' ? receiptUrl : null,
        notes: typeof notes === 'string' ? notes : null,
        status: 'pending',
      },
    })

    return NextResponse.json(
      {
        manualPayment: {
          ...payment,
          amountPaid: payment.amountPaid.toString(),
          createdAt: payment.createdAt.toISOString(),
        },
      },
      { status: 201 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/manual-payments error')
    return NextResponse.json({ error: 'Failed to record manual payment' }, { status: 500 })
  }
}
