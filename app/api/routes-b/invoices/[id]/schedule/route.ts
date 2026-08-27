import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// GET, POST /api/routes-b/invoices/[id]/schedule — list and create invoice payment schedule

const VALID_FREQUENCIES = ['weekly', 'biweekly', 'monthly'] as const

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

function computeInstallmentDates(count: number, frequency: string, from: Date): Date[] {
  const dates: Date[] = []
  for (let i = 1; i <= count; i++) {
    const due = new Date(from)
    switch (frequency) {
      case 'weekly':
        due.setDate(due.getDate() + i * 7)
        break
      case 'biweekly':
        due.setDate(due.getDate() + i * 14)
        break
      default:
        due.setMonth(due.getMonth() + i)
    }
    dates.push(due)
  }
  return dates
}

function formatPaymentPlan(plan: {
  id: string
  invoiceId: string
  totalAmount: unknown
  currency: string
  installmentCount: number
  frequency: string
  status: string
  createdAt: Date
  updatedAt: Date
  installments: Array<{
    id: string
    sequence: number
    amount: unknown
    dueDate: Date
    status: string
    paidAt: Date | null
  }>
}) {
  return {
    id: plan.id,
    invoiceId: plan.invoiceId,
    totalAmount: Number(plan.totalAmount),
    currency: plan.currency,
    installmentCount: plan.installmentCount,
    frequency: plan.frequency,
    status: plan.status,
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
    installments: plan.installments.map((i) => ({
      id: i.id,
      sequence: i.sequence,
      amount: Number(i.amount),
      dueDate: i.dueDate.toISOString(),
      status: i.status,
      paidAt: i.paidAt?.toISOString() ?? null,
    })),
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const invoice = await prisma.invoice.findFirst({
      where: { id, userId: user.id },
      select: { id: true },
    })
    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })

    const paymentPlan = await prisma.paymentPlan.findUnique({
      where: { invoiceId: id },
      include: { installments: { orderBy: { sequence: 'asc' } } },
    })

    if (!paymentPlan) {
      return NextResponse.json({ schedule: null, invoiceId: id })
    }

    return NextResponse.json({
      schedule: formatPaymentPlan(paymentPlan),
      invoiceId: id,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-b/invoices/[id]/schedule error')
    return NextResponse.json({ error: 'Failed to fetch invoice schedule' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const payload = (body ?? {}) as Record<string, unknown>
    const { installmentCount, frequency = 'monthly', startDate } = payload

    const parsedCount = Number(installmentCount)
    if (!Number.isInteger(parsedCount) || parsedCount < 2 || parsedCount > 60) {
      return NextResponse.json(
        { error: 'installmentCount must be an integer between 2 and 60' },
        { status: 400 },
      )
    }

    if (!(VALID_FREQUENCIES as readonly string[]).includes(frequency as string)) {
      return NextResponse.json(
        { error: `frequency must be one of: ${VALID_FREQUENCIES.join(', ')}` },
        { status: 400 },
      )
    }

    let fromDate = new Date()
    if (startDate !== undefined) {
      if (typeof startDate !== 'string') {
        return NextResponse.json({ error: 'startDate must be a valid ISO date string' }, { status: 400 })
      }
      const parsed = new Date(startDate)
      if (Number.isNaN(parsed.getTime())) {
        return NextResponse.json({ error: 'startDate must be a valid ISO date string' }, { status: 400 })
      }
      fromDate = parsed
    }

    const invoice = await prisma.invoice.findFirst({
      where: { id, userId: user.id },
      select: { id: true, amount: true, currency: true },
    })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    const existingPlan = await prisma.paymentPlan.findUnique({ where: { invoiceId: id } })
    if (existingPlan) {
      return NextResponse.json(
        { error: 'A payment schedule already exists for this invoice' },
        { status: 409 },
      )
    }

    const totalAmount = Number(invoice.amount)
    const installmentAmount = Math.round((totalAmount / parsedCount) * 100) / 100
    const dueDates = computeInstallmentDates(parsedCount, frequency as string, fromDate)

    const paymentPlan = await prisma.paymentPlan.create({
      data: {
        userId: user.id,
        invoiceId: invoice.id,
        totalAmount,
        currency: invoice.currency,
        installmentCount: parsedCount,
        frequency: frequency as string,
        status: 'active',
        installments: {
          create: dueDates.map((dueDate, i) => ({
            sequence: i + 1,
            amount:
              i === dueDates.length - 1
                ? Math.round((totalAmount - installmentAmount * (dueDates.length - 1)) * 100) / 100
                : installmentAmount,
            dueDate,
            status: 'pending',
          })),
        },
      },
      include: { installments: { orderBy: { sequence: 'asc' } } },
    })

    return NextResponse.json(
      { schedule: formatPaymentPlan(paymentPlan), invoiceId: id },
      { status: 201 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-b/invoices/[id]/schedule error')
    return NextResponse.json({ error: 'Failed to create invoice schedule' }, { status: 500 })
  }
}
