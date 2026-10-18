import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { extractRequestMetadata, logAuditEvent } from '@/lib/audit'
import { logger } from '@/lib/logger'

const ACTIVE_REFUND_STATUSES = ['pending', 'completed'] as const

type RouteContext = {
  params: Promise<{ id: string }> | { id: string }
}

async function resolveInvoiceId(context?: RouteContext): Promise<string> {
  if (!context?.params) return ''
  const resolved = await Promise.resolve(context.params)
  return (resolved?.id ?? '').trim()
}

function toCents(value: unknown): number {
  const num = Number(value ?? 0)
  return Number.isFinite(num) ? Math.round(num * 100) : 0
}

function fromCents(cents: number): number {
  return Math.round(cents) / 100
}

function serializeRefund(refund: Record<string, any>) {
  return {
    id: refund.id,
    userId: refund.userId,
    invoiceId: refund.invoiceId,
    amount: Number(refund.amount),
    currency: refund.currency ?? 'USD',
    reason: refund.reason,
    status: refund.status ?? 'pending',
    createdAt: refund.createdAt
      ? new Date(refund.createdAt).toISOString()
      : null,
    updatedAt: refund.updatedAt
      ? new Date(refund.updatedAt).toISOString()
      : null,
  }
}

async function authenticate(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return {
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    }
  }
  const token = authHeader.slice(7).trim()
  if (!token) {
    return {
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    }
  }

  const claims = await verifyAuthToken(token)
  if (!claims) {
    return {
      error: NextResponse.json({ error: 'Invalid token' }, { status: 401 }),
    }
  }

  const user =
    (await prisma.user.findUnique({ where: { privyId: claims.userId } })) ??
    (await prisma.user.findUnique({ where: { id: claims.userId } }))
  if (!user) {
    return {
      error: NextResponse.json({ error: 'User not found' }, { status: 404 }),
    }
  }

  return { user }
}

function computeInvoicePaidCents(invoice: Record<string, any>): number {
  if (
    invoice.paidAmount !== undefined &&
    invoice.paidAmount !== null &&
    Number.isFinite(Number(invoice.paidAmount))
  ) {
    return toCents(invoice.paidAmount)
  }
  if (
    invoice.status === 'paid' ||
    invoice.status === 'partially_refunded' ||
    invoice.paidAt
  ) {
    return toCents(invoice.amount)
  }
  return 0
}

/**
 * GET /api/invoices/[id]/refunds
 * Lists refunds issued against an invoice, along with remaining refundable balance.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const invoiceId = await resolveInvoiceId(context)
    if (!invoiceId) {
      return NextResponse.json(
        { error: 'Invoice ID is required' },
        { status: 400 },
      )
    }

    const auth = await authenticate(request)
    if (auth.error) return auth.error
    const user = auth.user!

    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
    })
    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }
    if (invoice.userId !== user.id && user.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const refunds = ((await prisma.refund.findMany({
      where: { invoiceId },
      orderBy: { createdAt: 'desc' },
    })) ?? []) as Array<Record<string, any>>

    const paidCents = computeInvoicePaidCents(invoice)
    const priorRefundedCents = refunds
      .filter((r) =>
        (ACTIVE_REFUND_STATUSES as readonly string[]).includes(
          String(r.status ?? 'pending'),
        ),
      )
      .reduce((sum, r) => sum + toCents(r.amount), 0)

    const remainingRefundableCents = Math.max(0, paidCents - priorRefundedCents)

    return NextResponse.json({
      invoiceId,
      paidAmount: fromCents(paidCents),
      priorRefundsTotal: fromCents(priorRefundedCents),
      remainingRefundableAmount: fromCents(remainingRefundableCents),
      refunds: refunds.map(serializeRefund),
    })
  } catch (error) {
    logger?.error?.({ err: error }, 'GET /api/invoices/[id]/refunds error')
    return NextResponse.json(
      { error: 'Failed to fetch refunds' },
      { status: 500 },
    )
  }
}

/**
 * POST /api/invoices/[id]/refunds
 * Issues a new `Refund` (partial or full) against a paid invoice:
 * - Rejects a refund amount greater than the amount actually paid on the invoice,
 *   accounting for any prior refunds already issued (`pending` or `completed`).
 * - Requires a non-empty `reason`.
 * - Defaults `status` to `'pending'`, leaving actual funds movement to the processing step.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const invoiceId = await resolveInvoiceId(context)
    if (!invoiceId) {
      return NextResponse.json(
        { error: 'Invoice ID is required' },
        { status: 400 },
      )
    }

    const auth = await authenticate(request)
    if (auth.error) return auth.error
    const user = auth.user!

    let body: Record<string, unknown>
    try {
      body = ((await request.json()) ?? {}) as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const rawReason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (!rawReason) {
      return NextResponse.json(
        { error: 'reason is required and must be non-empty', code: 'REASON_REQUIRED' },
        { status: 400 },
      )
    }

    const parsedAmount = Number(body.amount)
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return NextResponse.json(
        { error: 'amount must be a positive number', code: 'INVALID_AMOUNT' },
        { status: 400 },
      )
    }

    const requestedCents = toCents(parsedAmount)
    if (requestedCents <= 0) {
      return NextResponse.json(
        { error: 'amount must be at least 0.01', code: 'INVALID_AMOUNT' },
        { status: 400 },
      )
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
    })
    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }
    if (invoice.userId !== user.id && user.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const paidCents = computeInvoicePaidCents(invoice)
    if (paidCents <= 0) {
      return NextResponse.json(
        {
          error: `Invoice has no paid balance available to refund (status: ${invoice.status})`,
          code: 'INVOICE_NOT_PAID',
        },
        { status: 422 },
      )
    }

    const existingRefunds = ((await prisma.refund.findMany({
      where: { invoiceId: invoice.id },
    })) ?? []) as Array<Record<string, any>>

    const priorRefundedCents = existingRefunds
      .filter((r) =>
        (ACTIVE_REFUND_STATUSES as readonly string[]).includes(
          String(r.status ?? 'pending'),
        ),
      )
      .reduce((sum, r) => sum + toCents(r.amount), 0)

    const remainingRefundableCents = Math.max(0, paidCents - priorRefundedCents)

    if (requestedCents > remainingRefundableCents) {
      return NextResponse.json(
        {
          error:
            'Refund amount exceeds the remaining refundable paid balance on this invoice',
          code: 'REFUND_EXCEEDS_PAID_BALANCE',
          requestedAmount: fromCents(requestedCents),
          paidAmount: fromCents(paidCents),
          priorRefundsTotal: fromCents(priorRefundedCents),
          remainingRefundableAmount: fromCents(remainingRefundableCents),
        },
        { status: 400 },
      )
    }

    const normalizedAmount = fromCents(requestedCents)

    const refund = await prisma.refund.create({
      data: {
        userId: invoice.userId,
        invoiceId: invoice.id,
        amount: normalizedAmount,
        currency: invoice.currency ?? 'USD',
        reason: rawReason,
        status: 'pending',
      },
    })

    if (typeof logAuditEvent === 'function') {
      await logAuditEvent(invoice.id, 'invoice.refund_issued', user.id, {
        ...(typeof extractRequestMetadata === 'function'
          ? extractRequestMetadata(request.headers)
          : {}),
        refundId: refund.id,
        amount: normalizedAmount,
        reason: rawReason,
      })
    }

    const remainingAfterCents = Math.max(
      0,
      remainingRefundableCents - requestedCents,
    )

    return NextResponse.json(
      {
        refund: serializeRefund(refund),
        paidAmount: fromCents(paidCents),
        priorRefundsTotal: fromCents(priorRefundedCents),
        remainingRefundableAmount: fromCents(remainingAfterCents),
      },
      { status: 201 },
    )
  } catch (error) {
    logger?.error?.({ err: error }, 'POST /api/invoices/[id]/refunds error')
    return NextResponse.json(
      { error: 'Failed to issue refund' },
      { status: 500 },
    )
  }
}
