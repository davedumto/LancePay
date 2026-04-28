import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { generateInvoiceNumber } from '@/lib/utils'
import { buildInvoiceWhereFilters } from '../_lib/invoice-filters'
import { getArchiveFilter, parseIncludeArchivedParam } from '../_lib/invoice-archive'

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return { error: NextResponse.json({ error: 'User not found' }, { status: 404 }) }
  }

  return { user }
}

async function getUniqueInvoiceNumber() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const invoiceNumber = generateInvoiceNumber()
    const existingInvoice = await prisma.invoice.findUnique({
      where: { invoiceNumber },
      select: { id: true },
    })

    if (!existingInvoice) {
      return invoiceNumber
    }
  }

  throw new Error('Failed to generate a unique invoice number')
}

export async function GET(request: NextRequest) {
  const auth = await getAuthenticatedUser(request)
  if ('error' in auth) {
    return auth.error
  }

  const { searchParams } = new URL(request.url)
  const status = searchParams.get('status')
  const includeArchived = parseIncludeArchivedParam(searchParams.get('includeArchived'))
  const page = Math.max(1, Number.parseInt(searchParams.get('page') || '1', 10) || 1)
  const limit = Math.min(
    50,
    Math.max(1, Number.parseInt(searchParams.get('limit') || '20', 10) || 20),
  )

  const validStatuses = ['pending', 'paid', 'overdue', 'cancelled']
  if (status && !validStatuses.includes(status)) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
  }

  let searchFilters = {}
  try {
    searchFilters = buildInvoiceWhereFilters({
      number: searchParams.get('number'),
      client: searchParams.get('client'),
      minAmount: searchParams.get('minAmount'),
      maxAmount: searchParams.get('maxAmount'),
      currency: searchParams.get('currency'),
    })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }

  const where = {
    userId: auth.user.id,
    ...(status ? { status } : {}),
    ...getArchiveFilter(includeArchived),
    ...searchFilters,
  }

  const total = await prisma.invoice.count({ where })
  const invoices = await prisma.invoice.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * limit,
    take: limit,
    select: {
      id: true,
      invoiceNumber: true,
      clientName: true,
      clientEmail: true,
      amount: true,
      currency: true,
      status: true,
      dueDate: true,
      createdAt: true,
    },
  })

  return NextResponse.json({
    invoices: invoices.map((invoice) => ({
      ...invoice,
      amount: Number(invoice.amount),
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  })
}

export async function POST(request: NextRequest) {
  const auth = await getAuthenticatedUser(request)
  if ('error' in auth) {
    return auth.error
  }

  const body = await request.json()
  const { clientEmail, clientName, description, amount, currency = 'USD', dueDate } = body

  if (!clientEmail || !description || amount === undefined || amount === null) {
    return NextResponse.json(
      { error: 'clientEmail, description, and amount are required' },
      { status: 400 },
    )
  }

  const parsedAmount = Number(amount)
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return NextResponse.json({ error: 'amount must be greater than 0' }, { status: 400 })
  }

  let parsedDueDate: Date | null = null
  if (dueDate) {
    parsedDueDate = new Date(dueDate)
    if (Number.isNaN(parsedDueDate.getTime())) {
      return NextResponse.json({ error: 'dueDate must be a valid date string' }, { status: 400 })
    }
  }

  const invoiceNumber = await getUniqueInvoiceNumber()
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || `https://${request.headers.get('host')}`
  const paymentLink = `${baseUrl}/pay/${invoiceNumber}`

  const invoice = await prisma.invoice.create({
    data: {
      userId: auth.user.id,
      invoiceNumber,
      clientEmail: String(clientEmail).toLowerCase(),
      clientName: clientName || null,
      description,
      amount: parsedAmount,
      currency,
      paymentLink,
      dueDate: parsedDueDate,
    },
  })

  return NextResponse.json(
    {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      paymentLink: invoice.paymentLink,
      status: invoice.status,
      amount: Number(invoice.amount),
      currency: invoice.currency,
    },
    { status: 201 },
  )
}
