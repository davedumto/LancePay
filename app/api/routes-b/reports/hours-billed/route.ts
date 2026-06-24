import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200
const MIN_YEAR = 2000
const MAX_YEAR = 2100

type TimeEntryDelegate = {
  findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>
}

function getTimeEntryDelegate(): TimeEntryDelegate {
  return (prisma as unknown as { timeEntry: TimeEntryDelegate }).timeEntry
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

function parseYear(raw: string | null): number | null {
  if (!raw) return null
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < MIN_YEAR || n > MAX_YEAR) return null
  return n
}

function parseMonth(raw: string | null): number | null {
  if (!raw) return null
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 1 || n > 12) return null
  return n
}

function parsePage(raw: string | null): number {
  if (!raw) return 1
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 1 ? n : 1
}

function parsePageSize(raw: string | null): number {
  if (!raw) return DEFAULT_PAGE_SIZE
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 1) return DEFAULT_PAGE_SIZE
  return Math.min(n, MAX_PAGE_SIZE)
}

function decimalToString(value: unknown): string {
  if (value === null || value === undefined) return '0'
  if (typeof (value as { toString?: () => string })?.toString === 'function') {
    return (value as { toString: () => string }).toString()
  }
  return String(value)
}

export async function GET(request: NextRequest) {
  const user = await getAuthenticatedUser(request)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = request.nextUrl
  const year = parseYear(url.searchParams.get('year'))
  const month = parseMonth(url.searchParams.get('month'))
  const page = parsePage(url.searchParams.get('page'))
  const pageSize = parsePageSize(url.searchParams.get('pageSize'))

  if (year === null && url.searchParams.has('year')) {
    return NextResponse.json(
      { error: `Invalid year. Must be an integer between ${MIN_YEAR} and ${MAX_YEAR}.` },
      { status: 400 },
    )
  }

  if (month === null && url.searchParams.has('month')) {
    return NextResponse.json(
      { error: 'Invalid month. Must be an integer between 1 and 12.' },
      { status: 400 },
    )
  }

  // Build date range filter
  let occurredOnFilter: Record<string, Date> | undefined
  if (year !== null) {
    const targetMonth = month ?? null
    if (targetMonth !== null) {
      const start = new Date(Date.UTC(year, targetMonth - 1, 1))
      const end = new Date(Date.UTC(year, targetMonth, 1))
      occurredOnFilter = { gte: start, lt: end }
    } else {
      const start = new Date(Date.UTC(year, 0, 1))
      const end = new Date(Date.UTC(year + 1, 0, 1))
      occurredOnFilter = { gte: start, lt: end }
    }
  }

  const where: Record<string, unknown> = { userId: user.id }
  if (occurredOnFilter) where.occurredOn = occurredOnFilter

  const delegate = getTimeEntryDelegate()
  const [entries, totalCount] = await Promise.all([
    delegate.findMany({
      where,
      orderBy: { occurredOn: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        invoiceId: true,
        description: true,
        hours: true,
        rateUsdc: true,
        occurredOn: true,
        status: true,
        createdAt: true,
      },
    }),
    (prisma as unknown as { timeEntry: { count: (a: Record<string, unknown>) => Promise<number> } }).timeEntry.count({ where }),
  ])

  const totalHours = entries.reduce((sum, e) => {
    const h = Number.parseFloat(decimalToString(e.hours))
    return sum + (Number.isFinite(h) ? h : 0)
  }, 0)

  const billedEntries = entries.filter((e) => e.status === 'billed')
  const billedHours = billedEntries.reduce((sum, e) => {
    const h = Number.parseFloat(decimalToString(e.hours))
    return sum + (Number.isFinite(h) ? h : 0)
  }, 0)

  return NextResponse.json({
    summary: {
      totalEntries: totalCount,
      totalHours: Number(totalHours.toFixed(2)),
      billedHours: Number(billedHours.toFixed(2)),
      unbilledHours: Number((totalHours - billedHours).toFixed(2)),
    },
    entries: entries.map((e) => ({
      id: e.id,
      invoiceId: e.invoiceId ?? null,
      description: e.description,
      hours: decimalToString(e.hours),
      rateUsdc: decimalToString(e.rateUsdc),
      occurredOn: e.occurredOn,
      status: e.status,
      createdAt: e.createdAt,
    })),
    pagination: {
      page,
      pageSize,
      totalCount,
      totalPages: Math.ceil(totalCount / pageSize),
    },
  })
}
