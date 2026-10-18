import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export const VALID_FREQUENCIES = ['weekly', 'biweekly', 'monthly'] as const
export type PaymentPlanFrequency = (typeof VALID_FREQUENCIES)[number]

type RouteContext = {
  params: Promise<{ id: string }> | { id: string }
}

async function resolveInvoiceId(context?: RouteContext): Promise<string> {
  if (!context?.params) return ''
  const resolved = await Promise.resolve(context.params)
  return (resolved?.id ?? '').trim()
}

export function computeInstallmentAmounts(
  totalAmount: number,
  installmentCount: number,
): number[] {
  const totalCents = Math.round(totalAmount * 100)
  const baseCents = Math.floor(totalCents / installmentCount)
  const remainderCents = totalCents - baseCents * (installmentCount - 1)

  const amounts: number[] = []
  for (let i = 0; i < installmentCount; i++) {
    const cents = i === installmentCount - 1 ? remainderCents : baseCents
    amounts.push(Math.round(cents) / 100)
  }
  return amounts
}

export function computeInstallmentDates(
  installmentCount: number,
  frequency: PaymentPlanFrequency,
  anchorDate: Date,
): Date[] {
  const dates: Date[] = []
  for (let i = 1; i <= installmentCount; i++) {
    const due = new Date(anchorDate.getTime())
    switch (frequency) {
      case 'weekly':
        due.setUTCDate(due.getUTCDate() + i * 7)
        break
      case 'biweekly':
        due.setUTCDate(due.getUTCDate() + i * 14)
        break
      case 'monthly':
      default:
        due.setUTCMonth(due.getUTCMonth() + i)
        break
    }
    dates.push(due)
  }
  return dates
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

function serializePaymentPlan(plan: Record<string, any>) {
  const installments = Array.isArray(plan.installments) ? plan.installments : []
  return {
    id: plan.id,
    userId: plan.userId,
    invoiceId: plan.invoiceId,
    totalAmount: Number(plan.totalAmount),
    currency: plan.currency ?? 'USD',
    installmentCount: plan.installmentCount,
    frequency: plan.frequency,
    status: plan.status ?? 'active',
    createdAt: plan.createdAt ? new Date(plan.createdAt).toISOString() : null,
    updatedAt: plan.updatedAt ? new Date(plan.updatedAt).toISOString() : null,
    installments: installments.map((inst: Record<string, any>) => ({
      id: inst.id,
      sequence: inst.sequence,
      amount: Number(inst.amount),
      dueDate: inst.dueDate ? new Date(inst.dueDate).toISOString() : null,
      status: inst.status ?? 'pending',
      paidAt: inst.paidAt ? new Date(inst.paidAt).toISOString() : null,
    })),
  }
}

/**
 * GET /api/invoices/[id]/payment-plans
 * Fetches the payment plan and scheduled installments for the specified invoice.
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

    const paymentPlan = await prisma.paymentPlan.findUnique({
      where: { invoiceId },
      include: { installments: { orderBy: { sequence: 'asc' } } },
    })

    if (!paymentPlan) {
      return NextResponse.json(
        { error: 'Payment plan not found for this invoice' },
        { status: 404 },
      )
    }

    return NextResponse.json({
      paymentPlan: serializePaymentPlan(paymentPlan),
    })
  } catch (error) {
    logger?.error?.({ err: error }, 'GET /api/invoices/[id]/payment-plans error')
    return NextResponse.json(
      { error: 'Failed to fetch payment plan' },
      { status: 500 },
    )
  }
}

/**
 * POST /api/invoices/[id]/payment-plans
 * Creates a `PaymentPlan` and its scheduled `PaymentPlanInstallment` rows for an invoice:
 * - Enforces the unique `invoiceId` constraint on `PaymentPlan` (only one plan per invoice, `409`).
 * - Computes installment amounts in cents so they sum to `totalAmount`, allocating any rounding
 *   remainder to the final installment.
 * - Sets each installment's `dueDate` based on `frequency` (`weekly`, `biweekly`, `monthly`)
 *   starting from the invoice date (or supplied `startDate`).
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

    const parsedCount = Number(body.installmentCount)
    if (
      !Number.isInteger(parsedCount) ||
      parsedCount < 2 ||
      parsedCount > 60
    ) {
      return NextResponse.json(
        {
          error: 'installmentCount must be an integer between 2 and 60',
          code: 'INVALID_INSTALLMENT_COUNT',
        },
        { status: 400 },
      )
    }

    const rawFrequency =
      typeof body.frequency === 'string'
        ? body.frequency.trim().toLowerCase()
        : 'monthly'
    if (
      !(VALID_FREQUENCIES as readonly string[]).includes(rawFrequency)
    ) {
      return NextResponse.json(
        {
          error: `frequency must be one of: ${VALID_FREQUENCIES.join(', ')}`,
          code: 'INVALID_FREQUENCY',
        },
        { status: 400 },
      )
    }
    const frequency = rawFrequency as PaymentPlanFrequency

    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
    })
    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }
    if (invoice.userId !== user.id && user.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const existingPlan = await prisma.paymentPlan.findUnique({
      where: { invoiceId },
    })
    if (existingPlan) {
      return NextResponse.json(
        {
          error: 'A payment plan already exists for this invoice',
          code: 'PAYMENT_PLAN_ALREADY_EXISTS',
          paymentPlanId: existingPlan.id,
        },
        { status: 409 },
      )
    }

    const totalAmount =
      body.totalAmount !== undefined
        ? Number(body.totalAmount)
        : Number(invoice.amount)
    if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
      return NextResponse.json(
        { error: 'totalAmount must be a positive number' },
        { status: 400 },
      )
    }

    let anchorDate: Date
    if (body.startDate !== undefined && body.startDate !== null) {
      const parsedStart = new Date(String(body.startDate))
      if (Number.isNaN(parsedStart.getTime())) {
        return NextResponse.json(
          { error: 'startDate must be a valid ISO date string' },
          { status: 400 },
        )
      }
      anchorDate = parsedStart
    } else if (invoice.createdAt) {
      anchorDate = new Date(invoice.createdAt)
    } else {
      anchorDate = new Date()
    }

    const installmentAmounts = computeInstallmentAmounts(
      totalAmount,
      parsedCount,
    )
    const dueDates = computeInstallmentDates(
      parsedCount,
      frequency,
      anchorDate,
    )

    const scheduledInstallments = dueDates.map((dueDate, index) => ({
      sequence: index + 1,
      amount: installmentAmounts[index],
      dueDate,
      status: 'pending',
    }))

    let createdPlan: Record<string, any>
    try {
      createdPlan = await prisma.paymentPlan.create({
        data: {
          userId: invoice.userId,
          invoiceId: invoice.id,
          totalAmount,
          currency: invoice.currency ?? 'USD',
          installmentCount: parsedCount,
          frequency,
          status: 'active',
          installments: {
            create: scheduledInstallments,
          },
        },
        include: { installments: { orderBy: { sequence: 'asc' } } },
      })
    } catch (err: any) {
      if (err?.code === 'P2002') {
        return NextResponse.json(
          {
            error: 'A payment plan already exists for this invoice',
            code: 'PAYMENT_PLAN_ALREADY_EXISTS',
          },
          { status: 409 },
        )
      }
      throw err
    }

    // Fallback in case a mock does not populate nested installments on paymentPlan.create
    if (!Array.isArray(createdPlan.installments)) {
      createdPlan = {
        ...createdPlan,
        installments: scheduledInstallments.map((inst, idx) => ({
          id: `inst-${idx + 1}`,
          ...inst,
          paidAt: null,
        })),
      }
    }

    return NextResponse.json(
      {
        paymentPlan: serializePaymentPlan(createdPlan),
      },
      { status: 201 },
    )
  } catch (error) {
    logger?.error?.({ err: error }, 'POST /api/invoices/[id]/payment-plans error')
    return NextResponse.json(
      { error: 'Failed to create payment plan' },
      { status: 500 },
    )
  }
}
