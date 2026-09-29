import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const SUPPORTED_CURRENCIES = ['USDC', 'NGN'] as const
const TOLERANCE = 0.01

export async function GET(request: NextRequest) {
  try {
    const token = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(token)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const params = new URL(request.url).searchParams
    const reportingCurrency = ((await params).('reportingCurrency') ?? 'USDC').toUpperCase()
    if (!SUPPORTED_CURRENCIES.includes(reportingCurrency as (typeof SUPPORTED_CURRENCIES)[number])) {
      return NextResponse.json({ error: 'reportingCurrency must be USDC or NGN' }, { status: 400 })
    }

    const asOf = (await params).('asOf') ? new Date((await params).('asOf')!) : new Date()
    if (Number.isNaN(asOf.getTime())) {
      return NextResponse.json({ error: 'asOf must be a valid date' }, { status: 400 })
    }

    const entries = await prisma.journalEntry.findMany({
      where: { userId: user.id, currency: { in: [...SUPPORTED_CURRENCIES] }, date: { lte: asOf } },
      select: { debitAccount: true, creditAccount: true, amount: true, currency: true },
    })

    const foreignCurrency = reportingCurrency === 'USDC' ? 'NGN' : 'USDC'
    const needsRate = entries.some((entry) => entry.currency === foreignCurrency)
    let snapshot = null
    let rate = 1
    let inverted = false

    if (needsRate) {
      snapshot = await prisma.fxRateSnapshot.findFirst({
        where: { fromCurrency: foreignCurrency, toCurrency: reportingCurrency, capturedAt: { lte: asOf } },
        orderBy: { capturedAt: 'desc' },
      })
      if (!snapshot) {
        snapshot = await prisma.fxRateSnapshot.findFirst({
          where: { fromCurrency: reportingCurrency, toCurrency: foreignCurrency, capturedAt: { lte: asOf } },
          orderBy: { capturedAt: 'desc' },
        })
        inverted = Boolean(snapshot)
      }
      if (!snapshot || Number(snapshot.rate) <= 0) {
        return NextResponse.json({ error: `No exchange rate available as of ${asOf.toISOString()}` }, { status: 422 })
      }
      rate = inverted ? 1 / Number(snapshot.rate) : Number(snapshot.rate)
    }

    const accounts: Record<string, { debits: number; credits: number }> = {}
    for (const entry of entries) {
      const amount = Number(entry.amount) * (entry.currency === reportingCurrency ? 1 : rate)
      accounts[entry.debitAccount] ??= { debits: 0, credits: 0 }
      accounts[entry.creditAccount] ??= { debits: 0, credits: 0 }
      accounts[entry.debitAccount].debits += amount
      accounts[entry.creditAccount].credits += amount
    }

    const lines = Object.entries(accounts).map(([account, totals]) => {
      const balance = totals.debits - totals.credits
      return { account, ...totals, balance, discrepancy: Math.abs(balance) >= TOLERANCE }
    })
    const totalDebits = lines.reduce((sum, line) => sum + line.debits, 0)
    const totalCredits = lines.reduce((sum, line) => sum + line.credits, 0)

    return NextResponse.json({
      asOf: asOf.toISOString(),
      reportingCurrency,
      rateSource: snapshot ? { source: snapshot.source, capturedAt: snapshot.capturedAt, inverted } : null,
      lines,
      discrepancies: lines.filter((line) => line.discrepancy).map((line) => line.account),
      totalDebits,
      totalCredits,
      balanced: Math.abs(totalDebits - totalCredits) < TOLERANCE,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/ledger/multi-currency-trial-balance error')
    return NextResponse.json({ error: 'Failed to generate multi-currency trial balance' }, { status: 500 })
  }
}
