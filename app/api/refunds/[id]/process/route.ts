import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const ALLOWED_TARGET_STATUSES = ['completed', 'failed'] as const
type TargetRefundStatus = (typeof ALLOWED_TARGET_STATUSES)[number]

type RouteContext = {
  params: Promise<{ id: string }> | { id: string }
}

async function resolveRefundId(context?: RouteContext): Promise<string> {
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

/**
 * PATCH /api/refunds/[id]/process
 * Transitions a `Refund` from `pending` to `completed` or `failed`:
 * - Restricted to `admin` role (`403` otherwise).
 * - Only allows transition from `pending` to `completed` or `failed`; rejects attempts
 *   to re-process an already-terminal refund (`completed` or `failed`) with `409`.
 * - On `completed`, updates the refund status and ensures the parent invoice's paid
 *   amount accounting reflects the completed refund so future refund-amount validation
 *   stays accurate.
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const authHeader = request.headers.get('authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const token = authHeader.slice(7).trim()
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const claims = await verifyAuthToken(token)
    if (!claims) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const user =
      (await prisma.user.findUnique({
        where: { privyId: claims.userId },
      })) ??
      (await prisma.user.findUnique({
        where: { id: claims.userId },
      }))

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    if (user.role !== 'admin') {
      return NextResponse.json(
        { error: 'Forbidden: admin access required', code: 'ADMIN_REQUIRED' },
        { status: 403 },
      )
    }

    const refundId = await resolveRefundId(context)
    if (!refundId) {
      return NextResponse.json(
        { error: 'Refund ID is required' },
        { status: 400 },
      )
    }

    let body: Record<string, unknown>
    try {
      body = ((await request.json()) ?? {}) as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const rawStatus =
      typeof body.status === 'string' ? body.status.trim().toLowerCase() : ''
    if (
      !ALLOWED_TARGET_STATUSES.includes(rawStatus as TargetRefundStatus)
    ) {
      return NextResponse.json(
        {
          error: 'status must be either "completed" or "failed"',
          code: 'INVALID_REFUND_STATUS',
        },
        { status: 400 },
      )
    }
    const nextStatus = rawStatus as TargetRefundStatus

    const existingRefund = await prisma.refund.findUnique({
      where: { id: refundId },
    })
    if (!existingRefund) {
      return NextResponse.json({ error: 'Refund not found' }, { status: 404 })
    }

    if (existingRefund.status !== 'pending') {
      return NextResponse.json(
        {
          error: `Refund is already in terminal state "${existingRefund.status}" and cannot be re-processed`,
          code: 'REFUND_ALREADY_PROCESSED',
          currentStatus: existingRefund.status,
        },
        { status: 409 },
      )
    }

    const executeTransition = async (tx: typeof prisma) => {
      // Conditional guard if updateMany is available to prevent concurrent double-processing
      if (typeof tx.refund?.updateMany === 'function') {
        const guarded = await tx.refund.updateMany({
          where: { id: refundId, status: 'pending' },
          data: { status: nextStatus },
        })
        if (guarded && typeof guarded.count === 'number' && guarded.count === 0) {
          return { conflict: true as const }
        }
      }

      const updatedRefund = await tx.refund.update({
        where: { id: refundId },
        data: { status: nextStatus },
      })

      let invoiceAccounting: {
        invoiceId: string
        invoiceAmount: number
        grossPaidAmount: number
        completedRefundsTotal: number
        pendingRefundsTotal: number
        netPaidAmount: number
        remainingRefundableAmount: number
        invoiceStatus: string
      } | null = null

      if (nextStatus === 'completed') {
        const invoice =
          typeof tx.invoice?.findUnique === 'function'
            ? await tx.invoice.findUnique({
                where: { id: existingRefund.invoiceId },
              })
            : null

        const siblingRefunds =
          typeof tx.refund?.findMany === 'function'
            ? ((await tx.refund.findMany({
                where: { invoiceId: existingRefund.invoiceId },
              })) ?? [])
            : [updatedRefund]

        // Ensure updatedRefund's new status is reflected in the list
        const normalizedRefunds = siblingRefunds.some(
          (r: any) => r.id === updatedRefund.id,
        )
          ? siblingRefunds.map((r: any) =>
              r.id === updatedRefund.id ? { ...r, status: 'completed' } : r,
            )
          : [...siblingRefunds, updatedRefund]

        const completedCents = normalizedRefunds
          .filter((r: any) => r.status === 'completed')
          .reduce((sum: number, r: any) => sum + toCents(r.amount), 0)

        const pendingCents = normalizedRefunds
          .filter((r: any) => r.status === 'pending')
          .reduce((sum: number, r: any) => sum + toCents(r.amount), 0)

        const invoiceCents = invoice
          ? toCents(invoice.amount)
          : completedCents + pendingCents
        const grossPaidCents =
          invoice &&
          (invoice.status === 'paid' ||
            invoice.status === 'partially_refunded' ||
            invoice.status === 'refunded' ||
            invoice.paidAt)
            ? invoiceCents
            : invoice
              ? toCents((invoice as any).paidAmount ?? invoice.amount)
              : invoiceCents

        const netPaidCents = Math.max(0, grossPaidCents - completedCents)
        const remainingRefundableCents = Math.max(
          0,
          grossPaidCents - completedCents - pendingCents,
        )

        let nextInvoiceStatus = invoice?.status ?? 'paid'
        if (invoice && completedCents >= grossPaidCents && grossPaidCents > 0) {
          nextInvoiceStatus = 'refunded'
          if (
            typeof tx.invoice?.update === 'function' &&
            invoice.status !== 'refunded'
          ) {
            await tx.invoice.update({
              where: { id: invoice.id },
              data: { status: 'refunded' },
            })
          }
        }

        invoiceAccounting = {
          invoiceId: existingRefund.invoiceId,
          invoiceAmount: fromCents(invoiceCents),
          grossPaidAmount: fromCents(grossPaidCents),
          completedRefundsTotal: fromCents(completedCents),
          pendingRefundsTotal: fromCents(pendingCents),
          netPaidAmount: fromCents(netPaidCents),
          remainingRefundableAmount: fromCents(remainingRefundableCents),
          invoiceStatus: nextInvoiceStatus,
        }
      }

      return {
        conflict: false as const,
        refund: updatedRefund,
        invoiceAccounting,
      }
    }

    const result =
      typeof prisma.$transaction === 'function'
        ? await prisma.$transaction(async (tx: any) => executeTransition(tx))
        : await executeTransition(prisma)

    if (result.conflict) {
      return NextResponse.json(
        {
          error: 'Refund was already processed concurrently',
          code: 'REFUND_ALREADY_PROCESSED',
        },
        { status: 409 },
      )
    }

    const { refund, invoiceAccounting } = result

    logger?.info?.(
      {
        adminId: user.id,
        refundId: refund.id,
        invoiceId: refund.invoiceId,
        status: refund.status,
      },
      'Processed refund status transition',
    )

    return NextResponse.json({
      refund: {
        id: refund.id,
        userId: refund.userId,
        invoiceId: refund.invoiceId,
        amount: Number(refund.amount),
        currency: refund.currency,
        reason: refund.reason,
        status: refund.status,
        createdAt: refund.createdAt
          ? new Date(refund.createdAt).toISOString()
          : null,
        updatedAt: refund.updatedAt
          ? new Date(refund.updatedAt).toISOString()
          : null,
      },
      ...(invoiceAccounting ? { invoiceAccounting } : {}),
    })
  } catch (error) {
    logger?.error?.({ err: error }, 'PATCH /api/refunds/[id]/process error')
    return NextResponse.json(
      { error: 'Failed to process refund' },
      { status: 500 },
    )
  }
}
