import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const MAX_DESCRIPTION_LENGTH = 500
const MAX_HOURS = 24
const MAX_RATE_USDC = 1_000_000
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200

type TimeEntryDelegate = {
  findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>
  create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

function getTimeEntryDelegate(): TimeEntryDelegate {
  return (prisma as unknown as { timeEntry: TimeEntryDelegate }).timeEntry
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

function decimalToString(value: unknown): string {
  if (value === null || value === undefined) return '0'
  if (typeof (value as { toString?: () => string })?.toString === 'function') {
    return (value as { toString: () => string }).toString()
  }
  return String(value)
}

function parseHours(value: unknown): string | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0 || value > MAX_HOURS) return null
    return value.toString()
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null
    const num = Number.parseFloat(trimmed)
    if (!Number.isFinite(num) || num <= 0 || num > MAX_HOURS) return null
    return trimmed
  }
  return null
}

function parseRate(value: unknown): string | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || value > MAX_RATE_USDC) return null
    return value.toString()
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) return null
    const num = Number.parseFloat(trimmed)
    if (!Number.isFinite(num) || num < 0 || num > MAX_RATE_USDC) return null
    return trimmed
  }
  return null
}

function parseOccurredOn(value: unknown): Date | null {
  if (typeof value !== 'string') return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime())) return null
  // Reject obviously bad dates so a typo doesn't silently create a 1900 entry.
  if (parsed.getUTCFullYear() < 2000 || parsed.getUTCFullYear() > 2100) return null
  return parsed
}

function parseLimit(raw: string | null): number {
  if (!raw) return DEFAULT_PAGE_SIZE
  const parsed = Number.parseInt(raw, 10)
  if (Number.isNaN(parsed) || parsed <= 0) return DEFAULT_PAGE_SIZE
  return Math.min(parsed, MAX_PAGE_SIZE)
}

export async function GET(request: NextRequest) {
  const user = await getAuthenticatedUser(request)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = request.nextUrl
  const limit = parseLimit(url.searchParams.get('limit'))
  const invoiceId = url.searchParams.get('invoiceId')?.trim() || undefined
  const status = url.searchParams.get('status')?.trim() || undefined

  const timeEntryDelegate = getTimeEntryDelegate()
  const entries = await timeEntryDelegate.findMany({
    where: {
      userId: user.id,
      ...(invoiceId ? { invoiceId } : {}),
      ...(status ? { status } : {}),
    },
    orderBy: [{ occurredOn: 'desc' }, { createdAt: 'desc' }],
    take: limit,
    select: {
      id: true,
      invoiceId: true,
      description: true,
      hours: true,
      rateUsdc: true,
      occurredOn: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
  })

  return NextResponse.json({
    entries: entries.map((entry) => ({
      id: entry.id,
      invoiceId: entry.invoiceId ?? null,
      description: entry.description,
      hours: decimalToString(entry.hours),
      rateUsdc: decimalToString(entry.rateUsdc),
      occurredOn: entry.occurredOn,
      status: entry.status,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    })),
  })
}

export async function POST(request: NextRequest) {
  const user = await getAuthenticatedUser(request)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const payload = (body ?? {}) as Record<string, unknown>

  const description =
    typeof payload.description === 'string' ? payload.description.trim() : ''
  if (!description || description.length > MAX_DESCRIPTION_LENGTH) {
    return NextResponse.json(
      { error: `Description is required and must be at most ${MAX_DESCRIPTION_LENGTH} characters` },
      { status: 400 },
    )
  }

  const hours = parseHours(payload.hours)
  if (!hours) {
    return NextResponse.json(
      { error: `Hours must be a positive number with up to 2 decimal places (max ${MAX_HOURS})` },
      { status: 400 },
    )
  }

  const rateUsdc = parseRate(payload.rateUsdc)
  if (!rateUsdc) {
    return NextResponse.json(
      { error: `rateUsdc must be a non-negative number with up to 6 decimal places (max ${MAX_RATE_USDC})` },
      { status: 400 },
    )
  }

  const occurredOn = parseOccurredOn(payload.occurredOn)
  if (!occurredOn) {
    return NextResponse.json(
      { error: 'occurredOn is required and must be a YYYY-MM-DD date' },
      { status: 400 },
    )
  }

  // Optional invoice ownership check: a freelancer can only attach a time
  // entry to an invoice they own. Sending an invoiceId for someone else's
  // invoice surfaces a 404 (not a 403) so the caller cannot probe for
  // invoice IDs that exist but are owned by other users.
  let invoiceId: string | null = null
  if (typeof payload.invoiceId === 'string' && payload.invoiceId.trim()) {
    invoiceId = payload.invoiceId.trim()
    const invoice = await prisma.invoice.findFirst({
      where: { id: invoiceId, userId: user.id },
      select: { id: true },
    })
    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }
  }

  const timeEntryDelegate = getTimeEntryDelegate()
  const created = await timeEntryDelegate.create({
    data: {
      userId: user.id,
      invoiceId,
      description,
      hours,
      rateUsdc,
      occurredOn,
      status: invoiceId ? 'billed' : 'draft',
    },
    select: {
      id: true,
      invoiceId: true,
      description: true,
      hours: true,
      rateUsdc: true,
      occurredOn: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
  })

  return NextResponse.json(
    {
      id: created.id,
      invoiceId: created.invoiceId ?? null,
      description: created.description,
      hours: decimalToString(created.hours),
      rateUsdc: decimalToString(created.rateUsdc),
      occurredOn: created.occurredOn,
      status: created.status,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
    },
    { status: 201 },
  )
}
