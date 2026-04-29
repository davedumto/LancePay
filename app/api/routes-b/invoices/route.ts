import { withRequestId } from '../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { generateInvoiceNumber } from '@/lib/utils'
import { decodeCursor, encodeCursor } from '../_lib/cursor'
import { findRecentDuplicateInvoice } from '../_lib/duplicate-detection'
import { buildInvoiceWhereFilters } from '../_lib/invoice-filters'
import { getArchiveFilter, parseIncludeArchivedParam } from '../_lib/invoice-archive'

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')

  if (!claims) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
  })

  if (!user) {
    return { error: NextResponse.json({ error: 'User not found' }, { status: 404 }) }
  }

  return { user }
}

async function getUniqueInvoiceNumber() {
  for (let i = 0; i < 5; i++) {
    const invoiceNumber = generateInvoiceNumber()

    const exists = await prisma.invoice.findUnique({
      where: { invoiceNumber },
      select: { id: true },
    })

    if (!exists) return invoiceNumber
  }

  throw new Error('Failed to generate invoice number')
}

/**
 * GET INVOICES (cursor + filters + archive support)
 */
async function GETHandler(request: NextRequest) {
  const auth = await getAuthenticatedUser(request)
  if ('error' in auth) return auth.error

  const { searchParams } = new URL(request.url)

  const status = searchParams.get('status')
  const includeArchived = parseIncludeArchivedParam(searchParams.get('includeArchived'))

  const limit = Math.min(
    50,
    Math.max(1, Number.parseInt(searchParams.get('limit') || '20', 10))
  )

  const cursorParam = searchParams.get('cursor')
  const decodedCursor = cursorParam ? decodeCursor(cursorParam) : null

  if (cursorParam && !decodedCursor) {
    return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 })
  }

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
    ...(decodedCursor
      ? {
          OR: [
            { createdAt: { lt: new Date(decodedCursor.createdAt) } },
            {
              AND: [
                { createdAt: new Date(decodedCursor.createdAt) },
                { id: { lt: decodedCursor.id } },
              ],
            },
          ],
        }
      : {}),
  }

  const invoices = await prisma.invoice.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  })

  const hasNext = invoices.length > limit
  const data = hasNext ? invoices.slice(0, limit) : invoices

  const last = data[data.length - 1]

  const nextCursor = hasNext
    ? encodeCursor({
        createdAt: last.createdAt.toISOString(),
        id: last.id,
      })
    : null

  return NextResponse.json({
    data: data.map((i) => ({
      ...i,
      amount: Number(i.amount),
    })),
    nextCursor,
  })
}

/**
 * CREATE INVOICE
 */
async function POSTHandler(request: NextRequest) {
  const auth = await getAuthenticatedUser(request)
  if ('error' in auth) return auth.error

  const body = await request.json()

  const {
    clientEmail,
    clientName,
    description,
    amount,
    currency = 'USD',
    dueDate,
  } = body

  if (!clientEmail || !description || amount == null) {
    return NextResponse.json(
      { error: 'clientEmail, description, and amount are required' },
      { status: 400 }
    )
  }

  const parsedAmount = Number(amount)
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return NextResponse.json(
      { error: 'amount must be greater than 0' },
      { status: 400 }
    )
  }

  const normalizedEmail = String(clientEmail).toLowerCase()
  const normalizedCurrency = String(currency).toUpperCase()

  const force = new URL(request.url).searchParams.get('force') === 'true'

  if (!force) {
    const duplicate = await findRecentDuplicateInvoice({
      userId: auth.user.id,
      clientEmail: normalizedEmail,
      amount: parsedAmount,
      currency: normalizedCurrency,
    })

    if (duplicate) {
      return NextResponse.json(
        { duplicateOfId: duplicate },
        { status: 409 }
      )
    }
  }

  let parsedDueDate: Date | null = null
  if (dueDate) {
    parsedDueDate = new Date(dueDate)
    if (Number.isNaN(parsedDueDate.getTime())) {
      return NextResponse.json(
        { error: 'dueDate must be valid' },
        { status: 400 }
      )
    }
  }

  const invoiceNumber = await getUniqueInvoiceNumber()

  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ||
    `https://${request.headers.get('host')}`

  const paymentLink = `${baseUrl}/pay/${invoiceNumber}`

  const invoice = await prisma.invoice.create({
    data: {
      userId: auth.user.id,
      invoiceNumber,
      clientEmail: normalizedEmail,
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
    { status: 201 }
  )
}

export const GET = withRequestId(GETHandler)
export const POST = withRequestId(POSTHandler)