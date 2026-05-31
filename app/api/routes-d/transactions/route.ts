import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const ALLOWED_TYPES = new Set(['payment', 'withdrawal'])
const ALLOWED_STATUSES = new Set(['pending', 'completed', 'failed'])

async function getAuthenticatedUserId(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')

  if (!claims) {
    return null
  }

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })

  return user?.id ?? null
}

export async function GET(request: NextRequest) {
  const userId = await getAuthenticatedUserId(request)
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(request.url)
  const cursor = url.searchParams.get('cursor')
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '20', 10) || 20))
  const type = url.searchParams.get('type')
  const status = url.searchParams.get('status')

  if (type && !ALLOWED_TYPES.has(type)) {
    return NextResponse.json(
      { error: 'Invalid type. Allowed values are payment or withdrawal' },
      { status: 400 },
    )
  }

  if (status && !ALLOWED_STATUSES.has(status)) {
    return NextResponse.json(
      { error: 'Invalid status. Allowed values are pending, completed, or failed' },
      { status: 400 },
    )
  }

  const where = {
    userId,
    ...(type ? { type } : {}),
    ...(status ? { status } : {}),
  }

  // If cursor is provided, filter for transactions created before the cursor's timestamp
  const cursorWhere = cursor
    ? {
        ...where,
        createdAt: {
          lt: new Date(cursor),
        },
      }
    : where

  const transactions = await prisma.transaction.findMany({
    where: cursorWhere,
    orderBy: { createdAt: 'desc' },
    take: limit + 1, // Fetch one extra to determine if there's a next page
    include: {
      invoice: {
        select: {
          invoiceNumber: true,
        },
      },
    },
  })

  // Determine if there's a next page
  const hasNextPage = transactions.length > limit
  const paginatedTransactions = hasNextPage ? transactions.slice(0, limit) : transactions

  // Generate next cursor from the last transaction's createdAt timestamp
  const nextCursor = hasNextPage && paginatedTransactions.length > 0
    ? paginatedTransactions[paginatedTransactions.length - 1].createdAt.toISOString()
    : null

  return NextResponse.json({
    transactions: paginatedTransactions.map((transaction: (typeof paginatedTransactions)[number]) => ({
      id: transaction.id,
      type: transaction.type,
      status: transaction.status,
      amount: Number(transaction.amount),
      currency: transaction.currency,
      description: transaction.invoice?.invoiceNumber
        ? `Invoice ${transaction.invoice.invoiceNumber} paid`
        : transaction.type === 'withdrawal'
          ? 'Withdrawal initiated'
          : null,
      createdAt: transaction.createdAt,
    })),
    nextCursor,
  })
}
