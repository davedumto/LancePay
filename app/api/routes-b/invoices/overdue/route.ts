import { withRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { getArchiveFilter, parseIncludeArchivedParam } from '../../_lib/invoice-archive'
import { decodeCursor, encodeCursor } from '../../_lib/cursor'
import {
  emptyAgeingBuckets,
  getAgeingBucket,
  getDaysOverdueUtc,
  type AgeingBucketKey,
} from '../../_lib/ageing'

async function GETHandler(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const { searchParams } = new URL(request.url)
    const includeArchived = parseIncludeArchivedParam(searchParams.get('includeArchived'))
    const now = new Date()

    if (searchParams.get('bucketed') === 'true') {
      const invoices = await prisma.invoice.findMany({
        where: {
          userId: user.id,
          status: 'pending',
          dueDate: { lt: now, not: null },
          ...getArchiveFilter(includeArchived),
        },
        orderBy: { dueDate: 'asc' },
        select: {
          id: true,
          invoiceNumber: true,
          clientName: true,
          amount: true,
          currency: true,
          dueDate: true,
          createdAt: true,
        },
      })

      const buckets = emptyAgeingBuckets<{
        id: string
        invoiceNumber: string
        clientName: string
        amount: number
        currency: string
        dueDate: Date
        createdAt: Date
        daysOverdue: number
      }>()
      const totals: Record<AgeingBucketKey, { count: number; amount: number }> = {
        '1_30': { count: 0, amount: 0 },
        '31_60': { count: 0, amount: 0 },
        '61_90': { count: 0, amount: 0 },
        '90_plus': { count: 0, amount: 0 },
      }

      for (const invoice of invoices) {
        const daysOverdue = getDaysOverdueUtc(invoice.dueDate!, now)
        const bucket = getAgeingBucket(daysOverdue)
        const amount = Number(invoice.amount)
        buckets[bucket].push({
          ...invoice,
          amount,
          daysOverdue,
        })
        totals[bucket].count += 1
        totals[bucket].amount += amount
      }

      return NextResponse.json({ buckets, totals })
    }

    const limit = Math.min(
      100,
      Math.max(1, Number.parseInt(searchParams.get('limit') || '25', 10) || 25),
    )

    const cursorParam = searchParams.get('cursor')
    const decodedCursor = cursorParam ? decodeCursor(cursorParam) : null

    if (cursorParam && !decodedCursor) {
      return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 })
    }

    const where = {
      userId: user.id,
      status: 'pending',
      dueDate: { lt: now, not: null },
      ...getArchiveFilter(includeArchived),
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
      select: {
        id: true,
        invoiceNumber: true,
        clientName: true,
        amount: true,
        currency: true,
        dueDate: true,
        createdAt: true,
      },
    })

    const hasNext = invoices.length > limit
    const page = hasNext ? invoices.slice(0, limit) : invoices
    const last = page[page.length - 1]

    return NextResponse.json({
      invoices: page.map((invoice) => ({
        ...invoice,
        amount: Number(invoice.amount),
        daysOverdue: Math.floor(
          (now.getTime() - invoice.dueDate!.getTime()) / (1000 * 60 * 60 * 24),
        ),
      })),
      nextCursor:
        hasNext && last
          ? encodeCursor({
              createdAt: last.createdAt.toISOString(),
              id: last.id,
            })
          : null,
    })
  } catch (error) {
    logger.error({ err: error }, 'Routes-B invoice overdue GET error')
    return NextResponse.json({ error: 'Failed to list overdue invoices' }, { status: 500 })
  }
}

export const GET = withRequestId(GETHandler)
