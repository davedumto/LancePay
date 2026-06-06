import crypto from 'node:crypto'

import { withRequestId } from '../_lib/with-request-id'
import { withMethods } from '../_lib/with-methods'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { generateInvoiceNumber } from '@/lib/utils'

import { buildInvoiceWhereFilters } from '../_lib/invoice-filters'

import {
  getArchiveFilter,
  parseIncludeArchivedParam,
} from '../_lib/invoice-archive'

import { decodeCursor, encodeCursor } from '../_lib/cursor'
import { findRecentDuplicateInvoice } from '../_lib/duplicate-detection'
import { emitStatsInvalidated } from '../_lib/events'
import { buildLinkHeader } from '../_lib/link-header'

import {
  getIdempotentResponse,
  setIdempotentResponse,
} from '../_lib/idempotency'

import { registerRoute } from '../_lib/openapi'
import { z } from 'zod'

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000

/* ---------------- OPENAPI ---------------- */

registerRoute({
  method: 'GET',
  path: '/invoices',
  summary: 'List invoices',
  description: 'Cursor-paginated invoices for authenticated user.',
  requestSchema: z.object({
    status: z.enum(['pending', 'paid', 'overdue', 'cancelled']).optional(),
    cursor: z.string().optional(),
    limit: z.string().optional(),
    includeArchived: z.string().optional(),
  }),
  responseSchema: z.object({
    data: z.array(
      z.object({
        id: z.string(),
        invoiceNumber: z.string(),
        clientName: z.string().nullable(),
        clientEmail: z.string(),
        amount: z.number(),
        currency: z.string(),
        status: z.string(),
        dueDate: z.string().nullable(),
        createdAt: z.string(),
      })
    ),
    nextCursor: z.string().nullable(),
  }),
  tags: ['invoices'],
})

registerRoute({
  method: 'POST',
  path: '/invoices',
  summary: 'Create invoice',
  description: 'Create invoice, prevents duplicates unless forced.',
  requestSchema: z.object({
    clientEmail: z.string().email(),
    clientName: z.string().optional(),
    description: z.string().min(1),
    amount: z.number().positive(),
    currency: z.string().optional(),
    dueDate: z.string().optional(),
  }),
  responseSchema: z.object({
    id: z.string(),
    invoiceNumber: z.string(),
    paymentLink: z.string(),
    status: z.string(),
    amount: z.number(),
    currency: z.string(),
  }),
  tags: ['invoices'],
})

/* ---------------- AUTH ---------------- */

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers
    .get('authorization')
    ?.replace('Bearer ', '')

  const claims = await verifyAuthToken(authToken || '')

  if (!claims) {
    return {
      error: NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      ),
    }
  }

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
  })

  if (!user) {
    return {
      error: NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      ),
    }
  }

  return { user }
}

/* ---------------- HELPERS ---------------- */

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

/* ---------------- GET ---------------- */

async function GETHandler(request: NextRequest) {
  const auth = await getAuthenticatedUser(request)

  if ('error' in auth) return auth.error

  const { searchParams } = new URL(request.url)

  const status = searchParams.get('status')

  const includeArchived = parseIncludeArchivedParam(
    searchParams.get('includeArchived')
  )

  const limit = Math.min(
    100,
    Math.max(
      1,
      Number.parseInt(searchParams.get('limit') || '25', 10)
    )
  )

  const cursorParam = searchParams.get('cursor')

  const decodedCursor = cursorParam
    ? decodeCursor(cursorParam)
    : null

  if (cursorParam && !decodedCursor) {
    return NextResponse.json(
      { error: 'Invalid cursor' },
      { status: 400 }
    )
  }

  const validStatuses = [
    'pending',
    'paid',
    'overdue',
    'cancelled',
  ]

  if (status && !validStatuses.includes(status)) {
    return NextResponse.json(
      { error: 'Invalid status' },
      { status: 400 }
    )
  }

  const searchFilters = buildInvoiceWhereFilters({
    number: searchParams.get('number'),
    client: searchParams.get('client'),
    notes: searchParams.get('notes'),
    minAmount: searchParams.get('minAmount'),
    maxAmount: searchParams.get('maxAmount'),
    currency: searchParams.get('currency'),
  })

  const where = {
    userId: auth.user.id,
    ...(status ? { status } : {}),
    ...getArchiveFilter(includeArchived),
    ...searchFilters,

    ...(decodedCursor
      ? {
          OR: [
            {
              createdAt: {
                lt: new Date(decodedCursor.createdAt),
              },
            },
            {
              AND: [
                {
                  createdAt: new Date(
                    decodedCursor.createdAt
                  ),
                },
                {
                  id: {
                    lt: decodedCursor.id,
                  },
                },
              ],
            },
          ],
        }
      : {}),
  }

  const invoices = await prisma.invoice.findMany({
    where,
    orderBy: [
      { createdAt: 'desc' },
      { id: 'desc' },
    ],
    take: limit + 1,
  })

  const hasNext = invoices.length > limit

  const page = hasNext
    ? invoices.slice(0, limit)
    : invoices

  const last = page[page.length - 1]

  const nextCursor = hasNext && last
    ? encodeCursor({
        createdAt: last.createdAt.toISOString(),
        id: last.id,
      })
    : null

  const response = NextResponse.json({
    data: page.map((i) => ({
      ...i,
      amount: Number(i.amount),
    })),

    nextCursor,
  })

  const linkHeader = buildLinkHeader(request.url, nextCursor)
  if (linkHeader) {
    response.headers.set('Link', linkHeader)
  }

  return response
}

/* ---------------- POST ---------------- */

async function POSTHandler(request: NextRequest) {
  const auth = await getAuthenticatedUser(request)

  if ('error' in auth) return auth.error

  const body = await request.json().catch(() => null)

  const idempotencyKey = request.headers.get('idempotency-key')
  const bodyHash = body ? crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex') : ''

  if (idempotencyKey) {
    const cached = getIdempotentResponse(idempotencyKey)

    if (cached) {
      if (cached.bodyHash !== bodyHash) {
        return NextResponse.json(
          { error: 'Idempotency-Key conflict' },
          { status: 409 }
        )
      }

      return NextResponse.json(
        cached.body,
        { status: cached.status }
      )
    }
  }

  if (!body) {
    return NextResponse.json(
      { error: 'Invalid JSON body' },
      { status: 400 }
    )
  }

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
      { error: 'Missing required fields' },
      { status: 400 }
    )
  }

  const parsedAmount = Number(amount)

  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return NextResponse.json(
      { error: 'Invalid amount' },
      { status: 400 }
    )
  }

  const normalizedEmail = String(clientEmail).toLowerCase()

  const normalizedCurrency = String(currency).toUpperCase()

  const force =
    new URL(request.url).searchParams.get('force') ===
    'true'

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

  const parsedDueDate = dueDate
    ? new Date(dueDate)
    : null

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

  emitStatsInvalidated({ userId: auth.user.id })

  const responseBody = {
    id: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    paymentLink: invoice.paymentLink,
    status: invoice.status,
    amount: Number(invoice.amount),
    currency: invoice.currency,
  }

  if (idempotencyKey) {
    setIdempotentResponse(
      idempotencyKey,
      {
        bodyHash,
        status: 201,
        body: responseBody,
      },
      IDEMPOTENCY_TTL_MS
    )
  }

  return NextResponse.json(
    responseBody,
    { status: 201 }
  )
}

/* ---------------- EXPORTS ---------------- */

export const { GET, POST } = withMethods({
  GET: withRequestId(GETHandler),
  POST: withRequestId(POSTHandler),
})