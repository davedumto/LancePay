import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

type RouteContext = {
  params:
    | Promise<{ id: string; installmentId: string }>
    | { id: string; installmentId: string }
}

async function resolveParams(
  context?: RouteContext,
): Promise<{ id: string; installmentId: string }> {
  if (!context?.params) return { id: '', installmentId: '' }
  const resolved = await Promise.resolve(context.params)
  return {
    id: (resolved?.id ?? '').trim(),
    installmentId: (resolved?.installmentId ?? '').trim(),
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

function serializeInstallment(installment: Record<string, any>) {
  return {
    id: installment.id,
    paymentPlanId: installment.paymentPlanId,
    sequence: installment.sequence,
    amount: Number(installment.amount),
    dueDate: installment.dueDate
      ? new Date(installment.dueDate).toISOString()
      : null,
    status: installment.status,
    paidAt: installment.paidAt
      ? new Date(installment.paidAt).toISOString()
      : null,
    createdAt: installment.createdAt
      ? new Date(installment.createdAt).toISOString()
      : null,
  }
}

/**
 * PATCH /api/payment-plans/[id]/installments/[installmentId]/mark-paid
 * Marks a single `PaymentPlanInstallment` as paid:
 * - Rejects marking an installment paid if it is already paid (`409`).
 * - Sets `paidAt` and `status: 'paid'` on the installment, then checks whether all
 *   sibling installments on the `PaymentPlan` are now paid before transitioning
 *   `PaymentPlan.status` to `'completed'`.
 * - Does not mark the parent `Invoice` paid until the `PaymentPlan` itself is `'completed'`.
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const { id: paymentPlanId, installmentId } = await resolveParams(context)
    if (!paymentPlanId || !installmentId) {
      return NextResponse.json(
        { error: 'Payment plan ID and installment ID are required' },
        { status: 400 },
      )
    }

    const auth = await authenticate(request)
    if (auth.error) return auth.error
    const user = auth.user!

    const paymentPlan = await prisma.paymentPlan.findUnique({
      where: { id: paymentPlanId },
      include: { installments: { orderBy: { sequence: 'asc' } } },
    })

    if (!paymentPlan) {
      return NextResponse.json(
        { error: 'Payment plan not found' },
        { status: 404 },
      )
    }

    if (paymentPlan.userId !== user.id && user.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    if (paymentPlan.status === 'cancelled') {
      return NextResponse.json(
        {
          error: 'Cannot mark installment paid on a cancelled payment plan',
          code: 'PAYMENT_PLAN_CANCELLED',
        },
        { status: 422 },
      )
    }

    let targetInstallment = Array.isArray(paymentPlan.installments)
      ? paymentPlan.installments.find((inst: any) => inst.id === installmentId)
      : null

    if (
      !targetInstallment &&
      typeof prisma.paymentPlanInstallment?.findUnique === 'function'
    ) {
      const fetched = await prisma.paymentPlanInstallment.findUnique({
        where: { id: installmentId },
      })
      if (fetched && fetched.paymentPlanId === paymentPlanId) {
        targetInstallment = fetched
      }
    }

    if (!targetInstallment) {
      return NextResponse.json(
        { error: 'Installment not found on this payment plan' },
        { status: 404 },
      )
    }

    if (
      targetInstallment.status === 'paid' ||
      targetInstallment.paidAt !== null && targetInstallment.paidAt !== undefined
    ) {
      return NextResponse.json(
        {
          error: 'Installment is already marked as paid',
          code: 'INSTALLMENT_ALREADY_PAID',
          paidAt: targetInstallment.paidAt
            ? new Date(targetInstallment.paidAt).toISOString()
            : null,
        },
        { status: 409 },
      )
    }

    const now = new Date()

    const executeMarkPaid = async (tx: typeof prisma) => {
      if (typeof tx.paymentPlanInstallment?.updateMany === 'function') {
        const guarded = await tx.paymentPlanInstallment.updateMany({
          where: {
            id: installmentId,
            paymentPlanId,
            status: { not: 'paid' },
            paidAt: null,
          },
          data: {
            status: 'paid',
            paidAt: now,
          },
        })
        if (guarded && typeof guarded.count === 'number' && guarded.count === 0) {
          return { conflict: true as const }
        }
      }

      const updatedInstallment = await tx.paymentPlanInstallment.update({
        where: { id: installmentId },
        data: {
          status: 'paid',
          paidAt: now,
        },
      })

      let siblingInstallments: Array<Record<string, any>> = []
      if (typeof tx.paymentPlanInstallment?.findMany === 'function') {
        siblingInstallments =
          (await tx.paymentPlanInstallment.findMany({
            where: { paymentPlanId },
            orderBy: { sequence: 'asc' },
          })) ?? []
      } else if (Array.isArray(paymentPlan.installments)) {
        siblingInstallments = paymentPlan.installments
      }

      const normalizedInstallments = siblingInstallments.some(
        (inst: any) => inst.id === installmentId,
      )
        ? siblingInstallments.map((inst: any) =>
            inst.id === installmentId
              ? { ...inst, status: 'paid', paidAt: now }
              : inst,
          )
        : [...siblingInstallments, updatedInstallment]

      const allInstallmentsPaid =
        normalizedInstallments.length > 0 &&
        normalizedInstallments.every(
          (inst: any) => inst.status === 'paid' && Boolean(inst.paidAt),
        )

      let updatedPlanStatus = paymentPlan.status
      let invoicePaid = false
      let updatedInvoice: Record<string, any> | null = null

      if (allInstallmentsPaid) {
        updatedPlanStatus = 'completed'
        if (typeof tx.paymentPlan?.update === 'function') {
          await tx.paymentPlan.update({
            where: { id: paymentPlanId },
            data: { status: 'completed' },
          })
        }

        // Only mark the parent Invoice paid when the PaymentPlan itself is completed
        if (typeof tx.invoice?.update === 'function') {
          updatedInvoice = await tx.invoice.update({
            where: { id: paymentPlan.invoiceId },
            data: {
              status: 'paid',
              paidAt: now,
            },
          })
          invoicePaid = true
        }
      }

      return {
        conflict: false as const,
        updatedInstallment,
        allInstallmentsPaid,
        updatedPlanStatus,
        invoicePaid,
        updatedInvoice,
        paidCount: normalizedInstallments.filter(
          (inst: any) => inst.status === 'paid',
        ).length,
        totalCount: normalizedInstallments.length,
      }
    }

    const result =
      typeof prisma.$transaction === 'function'
        ? await prisma.$transaction(async (tx: any) => executeMarkPaid(tx))
        : await executeMarkPaid(prisma)

    if (result.conflict) {
      return NextResponse.json(
        {
          error: 'Installment was already marked as paid concurrently',
          code: 'INSTALLMENT_ALREADY_PAID',
        },
        { status: 409 },
      )
    }

    logger?.info?.(
      {
        userId: user.id,
        paymentPlanId,
        installmentId,
        planCompleted: result.allInstallmentsPaid,
        invoicePaid: result.invoicePaid,
      },
      'Marked payment plan installment paid',
    )

    return NextResponse.json({
      installment: serializeInstallment(result.updatedInstallment),
      paymentPlan: {
        id: paymentPlan.id,
        invoiceId: paymentPlan.invoiceId,
        status: result.updatedPlanStatus,
        completed: result.allInstallmentsPaid,
        paidInstallments: result.paidCount,
        totalInstallments: result.totalCount,
      },
      invoice: {
        id: paymentPlan.invoiceId,
        markedPaid: result.invoicePaid,
        status: result.invoicePaid
          ? 'paid'
          : (result.updatedInvoice?.status ?? 'pending'),
      },
    })
  } catch (error) {
    logger?.error?.(
      { err: error },
      'PATCH /api/payment-plans/[id]/installments/[installmentId]/mark-paid error',
    )
    return NextResponse.json(
      { error: 'Failed to mark installment as paid' },
      { status: 500 },
    )
  }
}

export { PATCH as POST }
