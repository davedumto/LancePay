import { withRequestId } from '../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

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
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') || '1', 10) || 1)
  const limit = Math.min(
    100,
    Math.max(1, Number.parseInt(url.searchParams.get('limit') || '20', 10) || 20),
  )

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
  }

  const [transactions, total] = await Promise.all([
    prisma.transaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        invoice: {
          select: {
            invoiceNumber: true,
          },
        },
      },
    }),
    prisma.transaction.count({ where }),
  ])

  return NextResponse.json({
    transactions: transactions.map((transaction) => ({
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
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  })
}

export const GET = withRequestId(GETHandler)
