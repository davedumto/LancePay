import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const VALID_FREQUENCIES = ['weekly', 'biweekly', 'monthly', 'quarterly'] as const
type Frequency = (typeof VALID_FREQUENCIES)[number]

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

async function findOwnedInvoice(invoiceId: string, userId: string) {
  return prisma.invoice.findFirst({
    where: { id: invoiceId, userId },
    select: { id: true, amount: true, currency: true, createdAt: true },
  })
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isValidFrequency(value: unknown): value is Frequency {
  return typeof value === 'string' && VALID_FREQUENCIES.includes(value as Frequency)
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date)
  result.setDate(result.getDate() + days)
  return result
}

function addMonths(date: Date, months: number): Date {
  const result = new Date(date)
  result.setMonth(result.getMonth() + months)
  return result
}

function calculateDueDates(startDate: Date, count: number, frequency: Frequency): Date[] {
  const dates: Date[] = []
  for (let i = 0; i < count; i++) {
    if (frequency === 'weekly') {
      dates.push(addDays(startDate, i * 7))
    } else if (frequency === 'biweekly') {
      dates.push(addDays(startDate, i * 14))
    } else if (frequency === 'monthly') {
      dates.push(addMonths(startDate, i))
    } else if (frequency === 'quarterly') {
      dates.push(addMonths(startDate, i * 3))
    }
  }
  return dates
}

/**
 * GET /api/invoices/[id]/payment-plans
 * Get the payment plan for an invoice.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: invoiceId } = await params
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    if (!invoiceId || !invoiceId.trim()) {
      return NextResponse.json({ error: 'Invoice ID is required' }, { status: 400 })
    }

    const invoice = await findOwnedInvoice(invoiceId, user.id)
    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    const paymentPlan = await prisma.paymentPlan.findFirst({
      where: { invoiceId },
      include: {
        installments: {
          orderBy: { sequence: 'asc' },
        },
      },
    })

    if (!paymentPlan) {
      return NextResponse.json({ error: 'Payment plan not found' }, { status: 404 })
    }

    return NextResponse.json({
      paymentPlan: {
        id: paymentPlan.id,
        invoiceId: paymentPlan.invoiceId,
        totalAmount: Number(paymentPlan.totalAmount),
        currency: paymentPlan.currency,
        installmentCount: paymentPlan.installmentCount,
        frequency: paymentPlan.frequency,
        status: paymentPlan.status,
        createdAt: paymentPlan.createdAt.toISOString(),
        updatedAt: paymentPlan.updatedAt.toISOString(),
        installments: paymentPlan.installments.map((installment) => ({
          id: installment.id,
          sequence: installment.sequence,
          amount: Number(installment.amount),
          dueDate: installment.dueDate.toISOString(),
          status: installment.status,
          paidAt: installment.paidAt ? installment.paidAt.toISOString() : null,
          createdAt: installment.createdAt.toISOString(),
        })),
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/invoices/[id]/payment-plans error')
    return NextResponse.json({ error: 'Failed to fetch payment plan' }, { status: 500 })
  }
}

/**
 * POST /api/invoices/[id]/payment-plans
 * Create a payment plan for an invoice.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: invoiceId } = await params
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    if (!invoiceId || !invoiceId.trim()) {
      return NextResponse.json({ error: 'Invoice ID is required' }, { status: 400 })
    }

    const invoice = await findOwnedInvoice(invoiceId, user.id)
    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    const existingPlan = await prisma.paymentPlan.findFirst({
      where: { invoiceId },
      select: { id: true },
    })

    if (existingPlan) {
      return NextResponse.json(
        { error: 'A payment plan already exists for this invoice' },
        { status: 409 },
      )
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const payload = (body ?? {}) as Record<string, unknown>
    const { installmentCount, frequency, startDate } = payload

    if (!isFiniteNumber(installmentCount) || installmentCount < 2 || installmentCount > 36) {
      return NextResponse.json(
        { error: 'installmentCount must be between 2 and 36' },
        { status: 400 },
      )
    }

    if (!isValidFrequency(frequency)) {
      return NextResponse.json(
        { error: `frequency must be one of: ${VALID_FREQUENCIES.join(', ')}` },
        { status: 400 },
      )
    }

    let planStartDate: Date
    if (startDate) {
      if (typeof startDate !== 'string') {
        return NextResponse.json({ error: 'startDate must be a string' }, { status: 400 })
      }
      planStartDate = new Date(startDate)
      if (isNaN(planStartDate.getTime())) {
        return NextResponse.json({ error: 'startDate must be a valid date' }, { status: 400 })
      }
    } else {
      planStartDate = invoice.createdAt
    }

    const totalAmount = Number(invoice.amount)
    const baseAmount = Math.floor((totalAmount / installmentCount) * 100) / 100
    const remainder = Math.round((totalAmount - baseAmount * installmentCount) * 100) / 100

    const dueDates = calculateDueDates(planStartDate, installmentCount, frequency as Frequency)

    const installmentData = dueDates.map((dueDate, index) => {
      const isLast = index === installmentCount - 1
      const amount = isLast ? baseAmount + remainder : baseAmount
      return {
        sequence: index + 1,
        amount,
        dueDate,
      }
    })

    const paymentPlan = await prisma.paymentPlan.create({
      data: {
        userId: user.id,
        invoiceId,
        totalAmount: invoice.amount,
        currency: invoice.currency,
        installmentCount,
        frequency: frequency as string,
        installments: {
          create: installmentData,
        },
      },
      include: {
        installments: {
          orderBy: { sequence: 'asc' },
        },
      },
    })

    return NextResponse.json(
      {
        paymentPlan: {
          id: paymentPlan.id,
          invoiceId: paymentPlan.invoiceId,
          totalAmount: Number(paymentPlan.totalAmount),
          currency: paymentPlan.currency,
          installmentCount: paymentPlan.installmentCount,
          frequency: paymentPlan.frequency,
          status: paymentPlan.status,
          createdAt: paymentPlan.createdAt.toISOString(),
          updatedAt: paymentPlan.updatedAt.toISOString(),
          installments: paymentPlan.installments.map((installment) => ({
            id: installment.id,
            sequence: installment.sequence,
            amount: Number(installment.amount),
            dueDate: installment.dueDate.toISOString(),
            status: installment.status,
            paidAt: installment.paidAt ? installment.paidAt.toISOString() : null,
            createdAt: installment.createdAt.toISOString(),
          })),
        },
      },
      { status: 201 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/invoices/[id]/payment-plans error')
    return NextResponse.json({ error: 'Failed to create payment plan' }, { status: 500 })
  }
}
