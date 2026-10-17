import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const ALLOWED_PAYMENT_METHODS = [
  'bank_transfer',
  'cash',
  'check',
  'wire',
  'mobile_money',
  'other',
] as const

const CURRENCY_REGEX = /^[A-Z]{2,10}$/
const DISALLOWED_INVOICE_STATUSES = new Set(['paid', 'cancelled', 'void', 'refunded'])

function extractToken(req: NextRequest): string | null {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  return authHeader.slice(7).trim() || null
}

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * GET /api/manual-payments
 * Lists manual payments for the authenticated user's invoices (or all for admin),
 * with optional filters for invoiceId, status, and paymentMethod.
 */
export async function GET(req: NextRequest) {
  try {
    const token = extractToken(req)
    const claims = token ? await verifyAuthToken(token) : null
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(req.url)
    const invoiceId = searchParams.get('invoiceId')?.trim() || undefined
    const status = searchParams.get('status')?.trim().toLowerCase() || undefined
    const paymentMethod =
      searchParams.get('paymentMethod')?.trim().toLowerCase() || undefined
    const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1)
    const limit = Math.min(
      100,
      Math.max(1, parseInt(searchParams.get('limit') ?? '20', 10) || 20),
    )
    const skip = (page - 1) * limit

    const where: Record<string, unknown> = {}
    if (claims.role !== 'admin') {
      where.invoice = { userId: claims.userId }
    }
    if (invoiceId) where.invoiceId = invoiceId
    if (status) where.status = status
    if (paymentMethod) where.paymentMethod = paymentMethod

    const [payments, total] = await Promise.all([
      prisma.manualPayment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          invoice: {
            select: {
              id: true,
              invoiceNumber: true,
              clientName: true,
              amount: true,
              currency: true,
              status: true,
            },
          },
        },
      }),
      prisma.manualPayment.count({ where }),
    ])

    const formatted = payments.map((p) => ({
      ...p,
      amountPaid: Number(p.amountPaid),
    }))

    return NextResponse.json({
      data: formatted,
      manualPayments: formatted,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    })
  } catch (err) {
    console.error('[GET /api/manual-payments]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * POST /api/manual-payments
 * Creates a pending manual payment record against an unpaid invoice after
 * validating invoice ownership, payment method, and remaining balance.
 */
export async function POST(req: NextRequest) {
  try {
    const token = extractToken(req)
    const claims = token ? await verifyAuthToken(token) : null
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let body: Record<string, unknown>
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const invoiceId =
      typeof body.invoiceId === 'string' ? body.invoiceId.trim() : ''
    const rawAmount = body.amountPaid ?? body.amount
    const paymentMethod =
      typeof body.paymentMethod === 'string'
        ? body.paymentMethod.trim().toLowerCase()
        : ''
    const receiptUrl =
      typeof body.receiptUrl === 'string' && body.receiptUrl.trim()
        ? body.receiptUrl.trim()
        : null
    const notes =
      typeof body.notes === 'string' && body.notes.trim()
        ? body.notes.trim()
        : null

    if (!invoiceId) {
      return NextResponse.json(
        { error: 'invoiceId is required' },
        { status: 400 },
      )
    }

    const amountPaid = Number(rawAmount)
    if (!Number.isFinite(amountPaid) || amountPaid <= 0) {
      return NextResponse.json(
        { error: 'amountPaid must be a positive number' },
        { status: 400 },
      )
    }

    if (
      !paymentMethod ||
      !ALLOWED_PAYMENT_METHODS.includes(
        paymentMethod as (typeof ALLOWED_PAYMENT_METHODS)[number],
      )
    ) {
      return NextResponse.json(
        {
          error: `paymentMethod must be one of: ${ALLOWED_PAYMENT_METHODS.join(', ')}`,
        },
        { status: 400 },
      )
    }

    if (receiptUrl && !isValidHttpUrl(receiptUrl)) {
      return NextResponse.json(
        { error: 'receiptUrl must be a valid HTTP or HTTPS URL' },
        { status: 400 },
      )
    }

    if (notes && notes.length > 1000) {
      return NextResponse.json(
        { error: 'notes must not exceed 1000 characters' },
        { status: 400 },
      )
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
    })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    if (invoice.userId !== claims.userId && claims.role !== 'admin') {
      return NextResponse.json(
        { error: 'Forbidden: You do not own this invoice' },
        { status: 403 },
      )
    }

    if (DISALLOWED_INVOICE_STATUSES.has(String(invoice.status).toLowerCase())) {
      return NextResponse.json(
        {
          error: `Invoice is already ${invoice.status} and cannot accept manual payments`,
        },
        { status: 409 },
      )
    }

    const currency =
      typeof body.currency === 'string' && body.currency.trim()
        ? body.currency.trim().toUpperCase()
        : String(invoice.currency || 'USDC').toUpperCase()

    if (!CURRENCY_REGEX.test(currency)) {
      return NextResponse.json(
        { error: 'Invalid currency code' },
        { status: 400 },
      )
    }

    const invoiceTotal = Number(invoice.amount)
    let existingPaidTotal = 0

    if (typeof prisma.manualPayment.findMany === 'function') {
      const existingPayments =
        (await prisma.manualPayment.findMany({
          where: {
            invoiceId,
            status: { in: ['pending', 'verified', 'reconciled'] },
          },
        })) ?? []

      existingPaidTotal = existingPayments.reduce(
        (sum, p) => sum + Number(p.amountPaid ?? 0),
        0,
      )
    }

    const remainingBalance = Number((invoiceTotal - existingPaidTotal).toFixed(2))
    if (invoiceTotal > 0 && amountPaid > remainingBalance + 0.0001) {
      return NextResponse.json(
        {
          error: 'amountPaid exceeds remaining invoice balance',
          invoiceAmount: invoiceTotal,
          existingManualPayments: existingPaidTotal,
          remainingBalance: Math.max(0, remainingBalance),
        },
        { status: 422 },
      )
    }

    const manualPayment = await prisma.manualPayment.create({
      data: {
        invoiceId,
        amountPaid,
        currency,
        paymentMethod,
        receiptUrl,
        notes,
        status: 'pending',
      },
    })

    const formatted = {
      ...manualPayment,
      amountPaid: Number(manualPayment.amountPaid),
    }

    return NextResponse.json(
      { manualPayment: formatted, data: formatted },
      { status: 201 },
    )
  } catch (err) {
    console.error('[POST /api/manual-payments]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
