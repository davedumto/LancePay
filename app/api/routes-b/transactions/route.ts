import { withRequestId, getRequestId } from '../_lib/with-request-id'
import { withMethods } from '../_lib/with-methods'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { decodeCursor, encodeCursor } from '../_lib/cursor'
import { buildLinkHeader } from '../_lib/link-header'
import { errorResponse } from '../_lib/errors'
import { logger } from '@/lib/logger'

const ALLOWED_TYPES = new Set(['payment', 'withdrawal'])
const ALLOWED_STATUSES = new Set(['pending', 'completed', 'failed'])

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
  const requestId = getRequestId()

  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) {
      return errorResponse('UNAUTHORIZED', 'Unauthorized', { requestId }, 401)
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return errorResponse('UNAUTHORIZED', 'Invalid token', { requestId }, 401)
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })
    if (!user) {
      return errorResponse('NOT_FOUND', 'User not found', { requestId }, 404)
    }

    const url = new URL(request.url)
    const type = url.searchParams.get('type')
    const status = url.searchParams.get('status')
    const from = parseDateParam(url.searchParams.get('from'), 'from')
    const to = parseDateParam(url.searchParams.get('to'), 'to')
    const limit = Math.min(
      100,
      Math.max(1, Number.parseInt(url.searchParams.get('limit') || '20', 10) || 20),
    )

    const cursorParam = url.searchParams.get('cursor')
    const decodedCursor = cursorParam ? decodeCursor(cursorParam) : null

    if (cursorParam && !decodedCursor) {
      return errorResponse(
        'BAD_REQUEST',
        'Invalid cursor',
        { fields: { cursor: 'Must be a valid pagination cursor' }, requestId },
        400,
      )
    }

    if (type && !ALLOWED_TYPES.has(type)) {
      return errorResponse(
        'BAD_REQUEST',
        'Invalid type',
        { fields: { type: 'Allowed values are payment or withdrawal' }, requestId },
        400,
      )
    }

    if (status && !ALLOWED_STATUSES.has(status)) {
      return errorResponse(
        'BAD_REQUEST',
        'Invalid status',
        { fields: { status: 'Allowed values are pending, completed, or failed' }, requestId },
        400,
      )
    }

    if (from && 'error' in from) {
      return errorResponse(
        'BAD_REQUEST',
        'Invalid from date',
        { fields: { from: from.error }, requestId },
        400,
      )
    }

    if (to && 'error' in to) {
      return errorResponse(
        'BAD_REQUEST',
        'Invalid to date',
        { fields: { to: to.error }, requestId },
        400,
      )
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
      ...(status ? { status } : {}),
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
                    createdAt: new Date(decodedCursor.createdAt),
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
  } catch (error) {
    logger.error({ err: error }, 'Routes-B transactions GET error')
    return errorResponse(
      'INTERNAL',
      'Failed to list transactions',
      { requestId },
      500,
    )
  }
}

export const { GET } = withMethods({
  GET: withRequestId(GETHandler),
})
