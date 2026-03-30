import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const INVOICE_STATUSES = ['pending', 'paid', 'overdue', 'cancelled'] as const
type InvoiceStatus = (typeof INVOICE_STATUSES)[number]

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

  const startOfThisMonth = new Date()
  startOfThisMonth.setUTCDate(1)
  startOfThisMonth.setUTCHours(0, 0, 0, 0)

  const [invoiceStats, earningStats, recentTransactions] = await Promise.all([
    prisma.invoice.groupBy({
      by: ['status'],
      where: { userId },
      _count: { id: true },
    }),
    prisma.$queryRaw<Array<{ totalEarned: Prisma.Decimal | number | null; thisMonth: Prisma.Decimal | number | null }>>(
      Prisma.sql`
        SELECT
          COALESCE(SUM("amount"), 0) AS "totalEarned",
          COALESCE(
            SUM(
              CASE
                WHEN "createdAt" >= ${startOfThisMonth} THEN "amount"
                ELSE 0
              END
            ),
            0
          ) AS "thisMonth"
        FROM "Transaction"
        WHERE "userId" = ${userId}
          AND "type" = 'payment'
          AND "status" = 'completed'
      `,
    ),
    prisma.transaction.findMany({
      where: {
        userId,
        status: 'completed',
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        id: true,
        type: true,
        amount: true,
        currency: true,
        createdAt: true,
      },
    }),
  ])

  const invoiceCounts = INVOICE_STATUSES.reduce<Record<InvoiceStatus, number>>(
    (accumulator, status) => {
      accumulator[status] = 0
      return accumulator
    },
    {} as Record<InvoiceStatus, number>,
  )

  let totalInvoices = 0
  for (const row of invoiceStats) {
    totalInvoices += row._count.id
    if (INVOICE_STATUSES.includes(row.status as InvoiceStatus)) {
      invoiceCounts[row.status as InvoiceStatus] = row._count.id
    }
  }
  const earnings = earningStats[0] ?? { totalEarned: 0, thisMonth: 0 }

  return NextResponse.json({
    summary: {
      invoices: {
        total: totalInvoices,
        pending: invoiceCounts.pending,
        paid: invoiceCounts.paid,
        overdue: invoiceCounts.overdue,
        cancelled: invoiceCounts.cancelled,
      },
      earnings: {
        totalEarned: Number(earnings.totalEarned ?? 0),
        thisMonth: Number(earnings.thisMonth ?? 0),
        currency: 'USDC',
      },
      recentTransactions: recentTransactions.map((transaction) => ({
        id: transaction.id,
        type: transaction.type,
        amount: Number(transaction.amount),
        currency: transaction.currency,
        createdAt: transaction.createdAt,
      })),
    },
  })
}
