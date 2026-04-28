import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { generateInvoiceNumber } from '@/lib/utils'
import { findRecentDuplicateInvoice } from '../_lib/duplicate-detection'
import { registerRoute } from '../_lib/openapi'
import { z } from 'zod'

// Register OpenAPI documentation
registerRoute({
  method: 'GET',
  path: '/invoices',
  summary: 'List invoices',
  description: 'Get paginated list of invoices for the authenticated user, optionally filtered by status.',
  requestSchema: z.object({
    status: z.enum(['pending', 'paid', 'overdue', 'cancelled']).optional(),
    page: z.string().optional().default('1'),
    limit: z.string().optional().default('20')
  }),
  responseSchema: z.object({
    invoices: z.array(z.object({
      id: z.string(),
      invoiceNumber: z.string(),
      clientName: z.string().nullable(),
      clientEmail: z.string(),
      amount: z.number(),
      currency: z.string(),
      status: z.string(),
      dueDate: z.string().nullable(),
      createdAt: z.string()
    })),
    pagination: z.object({
      page: z.number(),
      limit: z.number(),
      total: z.number(),
      totalPages: z.number()
    })
  }),
  tags: ['invoices']
})

registerRoute({
  method: 'POST',
  path: '/invoices',
  summary: 'Create invoice',
  description: 'Create a new invoice. Returns 409 if a similar invoice was created recently.',
  requestSchema: z.object({
    clientEmail: z.string().email(),
    clientName: z.string().optional(),
    description: z.string().min(1),
    amount: z.number().positive(),
    currency: z.string().default('USD'),
    dueDate: z.string().optional()
  }),
  responseSchema: z.object({
    id: z.string(),
    invoiceNumber: z.string(),
    paymentLink: z.string(),
    status: z.string(),
    amount: z.number(),
    currency: z.string()
  }),
  tags: ['invoices']
})

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
  const page = Math.max(1, Number.parseInt(searchParams.get('page') || '1', 10) || 1)
  const limit = Math.min(
    50,
    Math.max(1, Number.parseInt(searchParams.get('limit') || '20', 10) || 20),
  )

  const validStatuses = ['pending', 'paid', 'overdue', 'cancelled']
  if (status && !validStatuses.includes(status)) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
  }

  const where = {
    userId: auth.user.id,
    ...(status ? { status } : {}),
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

  const { searchParams } = new URL(request.url)
  const forceCreate = searchParams.get('force') === 'true'
  const normalizedClientEmail = String(clientEmail).toLowerCase()
  const normalizedCurrency = String(currency).toUpperCase()

  if (!forceCreate) {
    const duplicateInvoiceId = await findRecentDuplicateInvoice({
      userId: auth.user.id,
      clientEmail: normalizedClientEmail,
      amount: parsedAmount,
      currency: normalizedCurrency,
    })

    if (duplicateInvoiceId) {
      return NextResponse.json({ duplicateOfId: duplicateInvoiceId }, { status: 409 })
    }
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
      clientEmail: normalizedClientEmail,
      clientName: clientName || null,
      description,
      amount: parsedAmount,
      currency: normalizedCurrency,
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