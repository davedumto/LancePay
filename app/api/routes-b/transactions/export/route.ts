import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { createCsvStream } from '../../_lib/csv-stream'
import type { Prisma } from '@prisma/client'

export async function GET(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const claims = await verifyAuthToken(authToken)
  if (!claims) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
  })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const { searchParams } = new URL(request.url)
  const from = searchParams.get('from')
  const to = searchParams.get('to')

  const where: Prisma.TransactionWhereInput = { userId: user.id }
  
  if (from || to) {
    where.createdAt = {}
    if (from) {
      const fromDate = new Date(from)
      if (isNaN(fromDate.getTime())) {
        return NextResponse.json({ error: 'Invalid from date' }, { status: 400 })
      }
      where.createdAt.gte = fromDate
    }
    if (to) {
      const toDate = new Date(to)
      if (isNaN(toDate.getTime())) {
        return NextResponse.json({ error: 'Invalid to date' }, { status: 400 })
      }
      where.createdAt.lte = toDate
    }
  }

  type TransactionRow = {
    id: string
    type: string
    status: string
    amount: unknown
    currency: string
    createdAt: Date
    invoice: { description: string } | null
  }

  const stream = createCsvStream<TransactionRow>(
    [
      { header: 'id', value: row => row.id },
      { header: 'type', value: row => row.type },
      { header: 'status', value: row => row.status },
      { header: 'amount', value: row => Number(row.amount).toFixed(2) },
      { header: 'currency', value: row => row.currency },
      { header: 'description', value: row => row.invoice?.description ?? '' },
      { header: 'createdAt', value: row => row.createdAt },
    ],
    (cursor, batchSize) =>
      prisma.transaction.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: batchSize,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: {
          invoice: {
            select: {
              description: true,
            },
          },
        },
      }),
  )

  return new NextResponse(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename="transactions.csv"',
    },
  })
}
