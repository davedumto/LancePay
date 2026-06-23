import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const CURRENCY_PATTERN = /^[A-Z]{2,8}$/
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500
const MAX_LOOKBACK_DAYS = 365

type FxSnapshotDelegate = {
  findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>
}

function getSnapshotDelegate(): FxSnapshotDelegate {
  return (prisma as unknown as { fxRateSnapshot: FxSnapshotDelegate }).fxRateSnapshot
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')

  if (!claims) {
    return null
  }

  return prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })
}

function parseCurrency(raw: string | null): string | null {
  if (!raw) return null
  const upper = raw.trim().toUpperCase()
  return CURRENCY_PATTERN.test(upper) ? upper : null
}

function parseDate(raw: string | null): Date | null {
  if (!raw) return null
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function parseLimit(raw: string | null): number {
  if (!raw) return DEFAULT_LIMIT
  const parsed = Number.parseInt(raw, 10)
  if (Number.isNaN(parsed) || parsed <= 0) return DEFAULT_LIMIT
  return Math.min(parsed, MAX_LIMIT)
}

export async function GET(request: NextRequest) {
  const user = await getAuthenticatedUser(request)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = request.nextUrl
  const from = parseCurrency(url.searchParams.get('from'))
  const to = parseCurrency(url.searchParams.get('to'))

  if (!from || !to) {
    return NextResponse.json(
      { error: 'Both "from" and "to" currency codes are required (2-8 uppercase letters).' },
      { status: 400 },
    )
  }

  if (from === to) {
    return NextResponse.json(
      { error: '"from" and "to" must be different currency codes.' },
      { status: 400 },
    )
  }

  const startRaw = parseDate(url.searchParams.get('start'))
  const endRaw = parseDate(url.searchParams.get('end'))

  const now = new Date()
  const maxLookback = new Date(now.getTime() - MAX_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)

  // Default to the last 30 days when no range is supplied.
  const start = startRaw && startRaw >= maxLookback ? startRaw : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  const end = endRaw && endRaw > start ? endRaw : now

  if (end < start) {
    return NextResponse.json(
      { error: '"end" must be on or after "start".' },
      { status: 400 },
    )
  }

  const limit = parseLimit(url.searchParams.get('limit'))

  const snapshotDelegate = getSnapshotDelegate()
  const rows = await snapshotDelegate.findMany({
    where: {
      fromCurrency: from,
      toCurrency: to,
      capturedAt: { gte: start, lte: end },
    },
    orderBy: { capturedAt: 'asc' },
    take: limit,
    select: {
      capturedAt: true,
      rate: true,
      source: true,
    },
  })

  return NextResponse.json({
    from,
    to,
    start,
    end,
    rates: rows.map((row) => ({
      capturedAt: row.capturedAt,
      rate: row.rate?.toString?.() ?? row.rate,
      source: row.source,
    })),
  })
}
