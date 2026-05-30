import { withRequestId } from '../_lib/with-request-id'
import { withMethods } from '../_lib/with-methods'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { decodeCursor, encodeCursor } from '../_lib/cursor'
import { buildLinkHeader } from '../_lib/link-header'

const ALLOWED_TYPES = new Set(['payment', 'withdrawal'])

function parseDateParam(value: string | null, fieldName: 'from' | 'to') {
  if (!value) {
    return null
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return { error: `${fieldName} must be a valid ISO date string` }
  }

  return { date }
}

async function GETHandler(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const url = new URL(request.url)
  const type = url.searchParams.get('type')
  const from = parseDateParam(url.searchParams.get('from'), 'from')
  const to = parseDateParam(url.searchParams.get('to'), 'to')
  const limit = Math.min(
    100,
    Math.max(1, Number.parseInt(url.searchParams.get('limit') || '20', 10) || 20),
  )

  const cursorParam = url.searchParams.get('cursor')
  const decodedCursor = cursorParam ? decodeCursor(cursorParam) : null

  if (cursorParam && !decodedCursor) {
    return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 })
  }

  if (type && !ALLOWED_TYPES.has(type)) {
    return NextResponse.json(
      { error: 'Invalid type. Allowed values are payment or withdrawal' },
      { status: 400 },
    )
  }

  if (from && 'error' in from) {
    return NextResponse.json({ error: from.error }, { status: 400 })
  }

  if (to && 'error' in to) {
    return NextResponse.json({ error: to.error }, { status: 400 })
  }

  const createdAt =
    from?.date || to?.date
      ? {
          ...(from?.date ? { gte: from.date } : {}),
          ...(to?.date ? { lte: to.date } : {}),
        }
      : undefined

  const where = {
    userId: user.id,
    ...(type ? { type } : {}),
    ...(createdAt ? { createdAt } : {}),
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

  const transactions = await prisma.transaction.findMany({
    where,
    orderBy: [
      { createdAt: 'desc' },
      { id: 'desc' },
    ],
    take: limit + 1,
    include: {
      invoice: {
        select: {
          invoiceNumber: true,
        },
      },
    },
  })

  const hasNext = transactions.length > limit
  const page = hasNext
    ? transactions.slice(0, limit)
    : transactions

  const last = page[page.length - 1]
  const nextCursor = hasNext && last
    ? encodeCursor({
        createdAt: last.createdAt.toISOString(),
        id: last.id,
      })
    : null

  const response = NextResponse.json({
    transactions: page.map((transaction) => ({
      id: transaction.id,
      type: transaction.type,
      status: transaction.status,
      amount: Number(transaction.amount),
      currency: transaction.currency,
      description: transaction.invoice?.invoiceNumber
        ? `Invoice ${transaction.invoice.invoiceNumber} paid`
        : transaction.type === 'withdrawal'
          ? 'Withdrawal initiated'
          : 'Transaction recorded',
      createdAt: transaction.createdAt,
    })),
    nextCursor,
  })

  const linkHeader = buildLinkHeader(request.url, nextCursor)
  if (linkHeader) {
    response.headers.set('Link', linkHeader)
  }

  return response
}

export const { GET } = withMethods({
  GET: withRequestId(GETHandler),
})