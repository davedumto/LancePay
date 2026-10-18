import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

function extractToken(req: NextRequest): string | null {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  return authHeader.slice(7).trim() || null
}

export function roundDurationHours(rawHours: number, roundToMinutes?: number): number {
  if (roundToMinutes && Number.isFinite(roundToMinutes) && roundToMinutes > 0) {
    const stepHours = roundToMinutes / 60
    const rounded = Math.round(rawHours / stepHours) * stepHours
    return Number(Math.max(stepHours, rounded).toFixed(2))
  }
  return Number((Math.round(rawHours * 100) / 100).toFixed(2))
}

/**
 * GET /api/time-entries
 * Lists time entries for the authenticated freelancer with optional filters
 * for status, projectId, invoiceId, and occurredOn date range.
 */
export async function GET(req: NextRequest) {
  try {
    const token = extractToken(req)
    const claims = token ? await verifyAuthToken(token) : null
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(req.url)
    const status = searchParams.get('status')?.trim() || undefined
    const projectId = searchParams.get('projectId')?.trim() || undefined
    const invoiceId = searchParams.get('invoiceId')?.trim() || undefined
    const from = searchParams.get('from')?.trim()
    const to = searchParams.get('to')?.trim()
    const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1)
    const limit = Math.min(
      100,
      Math.max(1, parseInt(searchParams.get('limit') ?? '20', 10) || 20),
    )
    const skip = (page - 1) * limit

    const occurredOnFilter: { gte?: Date; lte?: Date } = {}
    if (from) {
      const fromDate = new Date(from)
      if (Number.isNaN(fromDate.getTime())) {
        return NextResponse.json(
          { error: 'Invalid from date parameter' },
          { status: 400 },
        )
      }
      occurredOnFilter.gte = fromDate
    }

    if (to) {
      const toDate = new Date(to)
      if (Number.isNaN(toDate.getTime())) {
        return NextResponse.json(
          { error: 'Invalid to date parameter' },
          { status: 400 },
        )
      }
      occurredOnFilter.lte = toDate
    }

    if (
      occurredOnFilter.gte &&
      occurredOnFilter.lte &&
      occurredOnFilter.gte > occurredOnFilter.lte
    ) {
      return NextResponse.json(
        { error: 'from date cannot be after to date' },
        { status: 400 },
      )
    }

    const where: Record<string, unknown> = { userId: claims.userId }
    if (status) where.status = status
    if (projectId) where.projectId = projectId
    if (invoiceId) where.invoiceId = invoiceId
    if (Object.keys(occurredOnFilter).length > 0) {
      where.occurredOn = occurredOnFilter
    }

    const [entries, total] = await Promise.all([
      prisma.timeEntry.findMany({
        where,
        orderBy: { occurredOn: 'desc' },
        skip,
        take: limit,
        include: {
          project: { select: { id: true, name: true } },
        },
      }),
      prisma.timeEntry.count({ where }),
    ])

    let totalHours = 0
    let totalAmount = 0

    const formatted = entries.map((entry) => {
      const hrs = Number(entry.hours)
      const rate = Number(entry.rateUsdc)
      const amount = Number((hrs * rate).toFixed(2))
      totalHours += hrs
      totalAmount += amount
      return {
        ...entry,
        hours: hrs,
        rateUsdc: rate,
        billableAmount: amount,
      }
    })

    return NextResponse.json({
      data: formatted,
      timeEntries: formatted,
      summary: {
        totalHours: Number(totalHours.toFixed(2)),
        totalAmount: Number(totalAmount.toFixed(2)),
      },
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    })
  } catch (err) {
    console.error('[GET /api/time-entries]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * POST /api/time-entries
 * Logs a new billable time entry with duration calculation/rounding, project
 * ownership verification, and daily/time-window overlap detection.
 */
export async function POST(req: NextRequest) {
  try {
    const token = extractToken(req)
    const claims = token ? await verifyAuthToken(token) : null
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let body: Record<string, unknown>
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const description =
      typeof body.description === 'string' ? body.description.trim() : ''
    if (!description) {
      return NextResponse.json(
        { error: 'description is required' },
        { status: 400 },
      )
    }

    const rawRate = body.rateUsdc
    const rateUsdc = Number(rawRate)
    if (
      rawRate === undefined ||
      rawRate === null ||
      !Number.isFinite(rateUsdc) ||
      rateUsdc < 0
    ) {
      return NextResponse.json(
        { error: 'rateUsdc must be a non-negative number' },
        { status: 400 },
      )
    }

    const roundToMinutes =
      body.roundToMinutes !== undefined ? Number(body.roundToMinutes) : undefined

    let hours: number
    let occurredDate: Date
    let startWindowMs: number | null = null
    let endWindowMs: number | null = null

    if (body.startTime && body.endTime) {
      const start = new Date(String(body.startTime))
      const end = new Date(String(body.endTime))
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        return NextResponse.json(
          { error: 'startTime and endTime must be valid ISO dates' },
          { status: 400 },
        )
      }
      if (end <= start) {
        return NextResponse.json(
          { error: 'endTime must be after startTime' },
          { status: 400 },
        )
      }
      startWindowMs = start.getTime()
      endWindowMs = end.getTime()
      const rawDurationHours = (endWindowMs - startWindowMs) / (1000 * 60 * 60)
      hours = roundDurationHours(rawDurationHours, roundToMinutes)
      occurredDate = body.occurredOn ? new Date(String(body.occurredOn)) : start
    } else {
      const rawHours = Number(body.hours)
      if (!Number.isFinite(rawHours) || rawHours <= 0 || rawHours > 24) {
        return NextResponse.json(
          { error: 'hours must be a number between 0 (exclusive) and 24' },
          { status: 400 },
        )
      }
      hours = roundDurationHours(rawHours, roundToMinutes)

      if (!body.occurredOn) {
        return NextResponse.json(
          { error: 'occurredOn is required when startTime/endTime are not provided' },
          { status: 400 },
        )
      }
      occurredDate = new Date(String(body.occurredOn))
    }

    if (Number.isNaN(occurredDate.getTime())) {
      return NextResponse.json(
        { error: 'occurredOn must be a valid date' },
        { status: 400 },
      )
    }

    if (hours <= 0 || hours > 24) {
      return NextResponse.json(
        { error: 'hours must be between 0 (exclusive) and 24' },
        { status: 400 },
      )
    }

    const projectId =
      typeof body.projectId === 'string' && body.projectId.trim()
        ? body.projectId.trim()
        : null

    if (projectId) {
      const project = await prisma.project.findFirst({
        where: { id: projectId, userId: claims.userId },
      })
      if (!project) {
        return NextResponse.json({ error: 'Project not found' }, { status: 404 })
      }
    }

    // Check daily total and time-window overlap
    const startOfDay = new Date(occurredDate)
    startOfDay.setUTCHours(0, 0, 0, 0)
    const endOfDay = new Date(occurredDate)
    endOfDay.setUTCHours(23, 59, 59, 999)

    const existingEntries =
      (await prisma.timeEntry.findMany({
        where: {
          userId: claims.userId,
          occurredOn: { gte: startOfDay, lte: endOfDay },
          status: { not: 'archived' },
        },
        select: { id: true, hours: true, occurredOn: true },
      })) ?? []

    if (startWindowMs !== null && endWindowMs !== null) {
      for (const existing of existingEntries) {
        const existingStartMs = new Date(existing.occurredOn).getTime()
        const existingEndMs =
          existingStartMs + Number(existing.hours) * 60 * 60 * 1000
        if (startWindowMs < existingEndMs && endWindowMs > existingStartMs) {
          return NextResponse.json(
            {
              error: 'Time entry overlaps with an existing time entry window',
              conflictingEntryId: existing.id,
            },
            { status: 409 },
          )
        }
      }
    }

    const existingHours = existingEntries.reduce(
      (sum, entry) => sum + Number(entry.hours),
      0,
    )
    if (existingHours + hours > 24) {
      return NextResponse.json(
        {
          error: `Total hours for ${startOfDay.toISOString().slice(0, 10)} would exceed 24 hours (${existingHours}h already logged)`,
          existingHours,
          requestedHours: hours,
        },
        { status: 409 },
      )
    }

    const entry = await prisma.timeEntry.create({
      data: {
        userId: claims.userId,
        description,
        hours,
        rateUsdc,
        occurredOn: occurredDate,
        projectId,
        status: 'draft',
      },
    })

    const billableAmount = Number((Number(entry.hours) * Number(entry.rateUsdc)).toFixed(2))
    const formatted = {
      ...entry,
      hours: Number(entry.hours),
      rateUsdc: Number(entry.rateUsdc),
      billableAmount,
    }

    return NextResponse.json(
      { data: formatted, timeEntry: formatted, billableAmount },
      { status: 201 },
    )
  } catch (err) {
    console.error('[POST /api/time-entries]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
