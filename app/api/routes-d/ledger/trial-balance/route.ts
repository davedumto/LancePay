import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { searchParams } = new URL(request.url)
    const asOf = searchParams.get('asOf')
    const dateFilter = asOf ? { lte: new Date(asOf) } : undefined

    const entries = await prisma.journalEntry.findMany({
      where: {
        userId: user.id,
        ...(dateFilter ? { date: dateFilter } : {}),
      },
      select: {
        debitAccount: true,
        creditAccount: true,
        amount: true,
      },
    })

    // Aggregate debits and credits per account
    const accounts: Record<string, { debits: number; credits: number }> = {}

    for (const entry of entries) {
      if (!accounts[entry.debitAccount]) {
        accounts[entry.debitAccount] = { debits: 0, credits: 0 }
      }
      if (!accounts[entry.creditAccount]) {
        accounts[entry.creditAccount] = { debits: 0, credits: 0 }
      }
      const amount = entry.amount ? Number(entry.amount) : 0
      accounts[entry.debitAccount].debits += amount
      accounts[entry.creditAccount].credits += amount
    }

    const lines = Object.entries(accounts).map(([account, { debits, credits }]) => ({
      account,
      debits,
      credits,
      balance: debits - credits,
    }))

    const totalDebits = lines.reduce((s, l) => s + l.debits, 0)
    const totalCredits = lines.reduce((s, l) => s + l.credits, 0)

    return NextResponse.json({
      asOf: asOf ?? new Date().toISOString(),
      lines,
      totalDebits,
      totalCredits,
      balanced: Math.abs(totalDebits - totalCredits) < 0.000001,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/ledger/trial-balance error')
    return NextResponse.json({ error: 'Failed to generate trial balance' }, { status: 500 })
  }
}
