import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// GET  /api/routes-b/invoices/[id]/tax-lines — list tax lines on an invoice
// POST /api/routes-b/invoices/[id]/tax-lines — add a tax line to an invoice

const MAX_NAME_LENGTH = 100

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
    select: { id: true, amount: true, currency: true, status: true },
  })
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } | Promise<{ id: string }> },
) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id: invoiceId } = await Promise.resolve(params)
    if (!invoiceId || !invoiceId.trim()) {
      return NextResponse.json({ error: 'Invoice ID is required' }, { status: 400 })
    }

    const invoice = await findOwnedInvoice(invoiceId, user.id)
    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    const taxLines = await prisma.invoiceTaxLine.findMany({
      where: { invoiceId },
      orderBy: { createdAt: 'asc' },
    })

    return NextResponse.json({ taxLines })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-b/invoices/[id]/tax-lines error')
    return NextResponse.json({ error: 'Failed to fetch invoice tax lines' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } | Promise<{ id: string }> },
) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id: invoiceId } = await Promise.resolve(params)
    if (!invoiceId || !invoiceId.trim()) {
      return NextResponse.json({ error: 'Invoice ID is required' }, { status: 400 })
    }

    const invoice = await findOwnedInvoice(invoiceId, user.id)
    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const payload = (body ?? {}) as {
      taxRateId?: string
      name?: string
      rate?: number
      amount?: number
    }

    let { name, rate, amount } = payload
    const { taxRateId } = payload

    if (taxRateId) {
      if (typeof taxRateId !== 'string' || !taxRateId.trim()) {
        return NextResponse.json({ error: 'taxRateId must be a valid string' }, { status: 400 })
      }
      const savedTaxRate = await prisma.taxRate.findFirst({
        where: { id: taxRateId, userId: user.id },
      })
      if (!savedTaxRate) {
        return NextResponse.json({ error: 'Tax rate not found' }, { status: 404 })
      }
      if (!name) name = savedTaxRate.name
      if (rate === undefined) rate = Number(savedTaxRate.rate)
    }

    if (!name || typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 })
    }

    if (name.trim().length > MAX_NAME_LENGTH) {
      return NextResponse.json(
        { error: `name must be at most ${MAX_NAME_LENGTH} characters` },
        { status: 400 },
      )
    }

    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 100) {
      return NextResponse.json(
        { error: 'rate must be a number between 0 and 100' },
        { status: 400 },
      )
    }

    // If amount is not explicitly provided, calculate it based on the invoice amount and rate
    let calculatedAmount = amount
    if (calculatedAmount === undefined || calculatedAmount === null) {
      const invoiceAmount = Number(invoice.amount) || 0
      // If rate is expressed as a whole percentage (e.g. 10 for 10%) vs decimal (e.g. 0.10)
      const normalizedRate = rate > 1 ? rate / 100 : rate
      calculatedAmount = parseFloat((invoiceAmount * normalizedRate).toFixed(2))
    } else if (typeof calculatedAmount !== 'number' || !Number.isFinite(calculatedAmount) || calculatedAmount < 0) {
      return NextResponse.json({ error: 'amount must be a non-negative number' }, { status: 400 })
    }

    const taxLine = await prisma.invoiceTaxLine.create({
      data: {
        invoiceId,
        taxRateId: taxRateId ?? null,
        name: name.trim(),
        rate,
        amount: calculatedAmount,
      },
    })

    logger.info(
      { userId: user.id, invoiceId, taxLineId: taxLine.id },
      'POST /api/routes-b/invoices/[id]/tax-lines',
    )

    return NextResponse.json({ taxLine }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-b/invoices/[id]/tax-lines error')
    return NextResponse.json({ error: 'Failed to add invoice tax line' }, { status: 500 })
  }
}
