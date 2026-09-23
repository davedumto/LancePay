import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// GET  /api/routes-b/time-entries — list the authenticated user's time entries
// POST /api/routes-b/time-entries — log a billable time entry with overlap detection

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const MAX_HOURS = 24
const MAX_HOURS_PER_DAY = 24
const DEFAULT_ROUNDING_MINUTES = 15
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

async function getAuthenticatedUser(request: NextRequest) {
  const token = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(token as string)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

function serialiseEntry(entry: {
  id: string
  invoiceId: string | null
  description: string
  hours: { toString(): string }
  rateUsdc: { toString(): string }
  occurredOn: Date
  status: string
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: entry.id,
    invoiceId: entry.invoiceId,
    description: entry.description,
    hours: entry.hours.toString(),
    rateUsdc: entry.rateUsdc.toString(),
    occurredOn: entry.occurredOn.toISOString().slice(0, 10),
    status: entry.status,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  }
}

// Round a raw hours value to the nearest rounding increment (default 15 minutes).
function roundHours(hours: number, roundingMinutes: number) {
  const increment = roundingMinutes / 60
  const rounded = Math.round(hours / increment) * increment
  // Guard against a value rounding down to zero (e.g. 5 minutes at nearest 15).
  return rounded < increment ? increment : Number(rounded.toFixed(2))
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const parsedLimit = Number(searchParams.get('limit'))
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(Math.floor(parsedLimit), MAX_LIMIT)
      : DEFAULT_LIMIT

    const entries = await prisma.timeEntry.findMany({
      where: { userId: user.id },
      orderBy: { occurredOn: 'desc' },
      take: limit,
    })

    return NextResponse.json({ entries: entries.map(serialiseEntry) })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-b/time-entries error')
    return NextResponse.json({ error: 'Failed to fetch time entries' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
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

    const payload = (body ?? {}) as {
      description?: unknown
      hours?: unknown
      rateUsdc?: unknown
      occurredOn?: unknown
      invoiceId?: unknown
      roundingMinutes?: unknown
    }

    const description =
      typeof payload.description === 'string' ? payload.description.trim() : ''
    if (!description) {
      return NextResponse.json({ error: 'description is required' }, { status: 400 })
    }
    if (description.length > 500) {
      return NextResponse.json(
        { error: 'description must be at most 500 characters' },
        { status: 400 },
      )
    }

    const hours = Number(payload.hours)
    if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_HOURS) {
      return NextResponse.json(
        { error: `hours must be a positive number no greater than ${MAX_HOURS}` },
        { status: 400 },
      )
    }

    const rateUsdc = Number(payload.rateUsdc)
    if (!Number.isFinite(rateUsdc) || rateUsdc < 0) {
      return NextResponse.json(
        { error: 'rateUsdc must be a non-negative number' },
        { status: 400 },
      )
    }

    if (typeof payload.occurredOn !== 'string' || !DATE_ONLY.test(payload.occurredOn)) {
      return NextResponse.json(
        { error: 'occurredOn must be a valid YYYY-MM-DD date' },
        { status: 400 },
      )
    }
    const occurredOn = new Date(`${payload.occurredOn}T00:00:00.000Z`)
    if (Number.isNaN(occurredOn.getTime())) {
      return NextResponse.json(
        { error: 'occurredOn must be a valid YYYY-MM-DD date' },
        { status: 400 },
      )
    }

    let roundingMinutes = DEFAULT_ROUNDING_MINUTES
    if (payload.roundingMinutes !== undefined) {
      const rm = Number(payload.roundingMinutes)
      if (!Number.isFinite(rm) || rm <= 0 || rm > 60) {
        return NextResponse.json(
          { error: 'roundingMinutes must be a number between 1 and 60' },
          { status: 400 },
        )
      }
      roundingMinutes = rm
    }

    let invoiceId: string | null = null
    if (payload.invoiceId !== undefined && payload.invoiceId !== null) {
      if (typeof payload.invoiceId !== 'string' || !payload.invoiceId.trim()) {
        return NextResponse.json(
          { error: 'invoiceId must be a non-empty string' },
          { status: 400 },
        )
      }
      invoiceId = payload.invoiceId.trim()
      const invoice = await prisma.invoice.findFirst({
        where: { id: invoiceId, userId: user.id },
        select: { id: true },
      })
      if (!invoice) {
        return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
      }
    }

    const roundedHours = roundHours(hours, roundingMinutes)

    // Overlap detection. The schema records a day (occurredOn) and a duration
    // (hours) rather than a start/end range, so two entries "overlap" when their
    // combined duration on the same day exceeds a 24-hour day for the same user.
    const sameDayEntries =
      (await prisma.timeEntry.findMany({
        where: { userId: user.id, occurredOn },
        select: { hours: true },
      })) || []

    const existingHours = sameDayEntries.reduce(
      (sum, e) => sum + Number(e.hours),
      0,
    )
    if (existingHours + roundedHours > MAX_HOURS_PER_DAY) {
      return NextResponse.json(
        {
          error: `Time entry overlaps existing entries for this day. Remaining billable hours: ${(
            MAX_HOURS_PER_DAY - existingHours
          ).toFixed(2)}`,
        },
        { status: 409 },
      )
    }

    const created = await prisma.timeEntry.create({
      data: {
        userId: user.id,
        invoiceId,
        description,
        hours: roundedHours,
        rateUsdc,
        occurredOn,
        status: 'draft',
      },
    })

    logger.info(
      { userId: user.id, timeEntryId: created.id, invoiceId },
      'POST /api/routes-b/time-entries',
    )

    return NextResponse.json(serialiseEntry(created), { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-b/time-entries error')
    return NextResponse.json({ error: 'Failed to create time entry' }, { status: 500 })
  }
}
