import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const PERIOD_REGEX = /^(\d{4})-(0[1-9]|1[0-2])$/

function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value)
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

export async function GET(
  request: NextRequest,
  { params }: any
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const {} = await params
    const match = PERIOD_REGEX.exec(period ?? '')
    if (!match) {
      return NextResponse.json(
        { error: 'Invalid period. Expected format YYYY-MM' },
        { status: 400 },
      )
    }

    const year = parseInt(match[1], 10)
    const month = parseInt(match[2], 10)
    const start = new Date(Date.UTC(year, month - 1, 1))
    const end = new Date(Date.UTC(year, month, 1))

    if (start.getTime() > Date.now()) {
      return NextResponse.json(
        { error: 'Period cannot be in the future' },
        { status: 400 },
      )
    }

    const { searchParams } = new URL(request.url)
    const format = (searchParams.get('format') ?? 'json').toLowerCase()
    if (format !== 'json' && format !== 'csv') {
      return NextResponse.json(
        { error: 'Invalid format. Supported: json, csv' },
        { status: 400 },
      )
    }

    const transactions = await prisma.transaction.findMany({
      where: {
        userId: user.id,
        createdAt: { gte: start, lt: end },
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        type: true,
        status: true,
        amount: true,
        currency: true,
        createdAt: true,
        completedAt: true,
      },
    })

    if (format === 'csv') {
      const header = 'id,type,status,amount,currency,createdAt,completedAt'
      const rows = transactions.map((tx) =>
        [
          tx.id,
          tx.type,
          tx.status,
          tx.amount,
          tx.currency,
          tx.createdAt?.toISOString?.() ?? tx.createdAt,
          tx.completedAt ? tx.completedAt.toISOString?.() ?? tx.completedAt : '',
        ]
          .map(csvEscape)
          .join(','),
      )
      const csv = [header, ...rows].join('\n')
      return new NextResponse(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="statement-${period}.csv"`,
        },
      })
    }

    // Aggregate totals per currency and per type for the summary block
    const totalsByCurrency: Record<string, { count: number; total: number }> = {}
    const totalsByType: Record<string, number> = {}
    for (const tx of transactions) {
      const amount = Number(tx.amount)
      const currency = tx.currency ?? 'USD'
      totalsByCurrency[currency] = totalsByCurrency[currency] ?? { count: 0, total: 0 }
      totalsByCurrency[currency].count += 1
      totalsByCurrency[currency].total += amount
      totalsByType[tx.type] = (totalsByType[tx.type] ?? 0) + amount
    }

    return NextResponse.json({
      statement: {
        period,
        periodStart: start.toISOString(),
        periodEnd: end.toISOString(),
        generatedAt: new Date().toISOString(),
        transactionCount: transactions.length,
        totalsByCurrency,
        totalsByType,
        transactions,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/statements/[period] error')
    return NextResponse.json({ error: 'Failed to export statement' }, { status: 500 })
  }
}
