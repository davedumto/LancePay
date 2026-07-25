import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const BALANCE_TOLERANCE = 0.005

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 401 })

    const asOfParam = request.nextUrl.searchParams.get('asOf')
    let asOf: Date | undefined
    if (asOfParam !== null) {
      if (Number.isNaN(Date.parse(asOfParam))) {
        return NextResponse.json(
          { error: 'asOf must be a valid ISO 8601 date string' },
          { status: 400 },
        )
      }
      asOf = new Date(asOfParam)
    }

    const grouped = await prisma.journalLine.groupBy({
      by: ['account'],
      where: {
        entry: {
          userId: user.id,
          status: 'posted',
          ...(asOf && { entryDate: { lte: asOf } }),
        },
      },
      _sum: { debit: true, credit: true },
      orderBy: { account: 'asc' },
    })

    const accounts = grouped.map((row) => {
      const debit = Number(row._sum.debit ?? 0)
      const credit = Number(row._sum.credit ?? 0)
      return {
        account: row.account,
        debit,
        credit,
        balance: Number((debit - credit).toFixed(2)),
      }
    })

    const totalDebit = Number(
      accounts.reduce((sum, row) => sum + row.debit, 0).toFixed(2),
    )
    const totalCredit = Number(
      accounts.reduce((sum, row) => sum + row.credit, 0).toFixed(2),
    )

    return NextResponse.json({
      asOf: asOf ? asOf.toISOString() : null,
      accounts,
      totals: {
        debit: totalDebit,
        credit: totalCredit,
        balanced: Math.abs(totalDebit - totalCredit) <= BALANCE_TOLERANCE,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /ledger/trial-balance error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
