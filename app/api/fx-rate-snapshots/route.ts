import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const CURRENCY_REGEX = /^[A-Z]{2,10}$/
const MAX_RATE_VALUE = 1_000_000_000
const MAX_DEVIATION_RATIO = 0.5 // 50% sanity threshold against prior snapshot

function extractToken(req: NextRequest): string | null {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  return authHeader.slice(7).trim() || null
}

/**
 * GET /api/fx-rate-snapshots
 * Retrieves historical and latest FX rate snapshots with optional currency pair,
 * source, and date-range filters.
 */
export async function GET(req: NextRequest) {
  try {
    const token = extractToken(req)
    const claims = token ? await verifyAuthToken(token) : null
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(req.url)
    const fromCurrency = (
      searchParams.get('fromCurrency') ??
      searchParams.get('from') ??
      ''
    )
      .trim()
      .toUpperCase()
    const toCurrency = (
      searchParams.get('toCurrency') ??
      searchParams.get('to') ??
      ''
    )
      .trim()
      .toUpperCase()
    const source = searchParams.get('source')?.trim() || undefined
    const startDateRaw =
      searchParams.get('startDate') ?? searchParams.get('fromDate')
    const endDateRaw = searchParams.get('endDate') ?? searchParams.get('toDate')

    if (fromCurrency && !CURRENCY_REGEX.test(fromCurrency)) {
      return NextResponse.json(
        { error: 'Invalid fromCurrency format' },
        { status: 400 },
      )
    }

    if (toCurrency && !CURRENCY_REGEX.test(toCurrency)) {
      return NextResponse.json(
        { error: 'Invalid toCurrency format' },
        { status: 400 },
      )
    }

    const capturedAtFilter: { gte?: Date; lte?: Date } = {}
    if (startDateRaw) {
      const parsedStart = new Date(startDateRaw)
      if (Number.isNaN(parsedStart.getTime())) {
        return NextResponse.json(
          { error: 'Invalid startDate parameter' },
          { status: 400 },
        )
      }
      capturedAtFilter.gte = parsedStart
    }

    if (endDateRaw) {
      const parsedEnd = new Date(endDateRaw)
      if (Number.isNaN(parsedEnd.getTime())) {
        return NextResponse.json(
          { error: 'Invalid endDate parameter' },
          { status: 400 },
        )
      }
      capturedAtFilter.lte = parsedEnd
    }

    if (
      capturedAtFilter.gte &&
      capturedAtFilter.lte &&
      capturedAtFilter.gte > capturedAtFilter.lte
    ) {
      return NextResponse.json(
        { error: 'startDate cannot be after endDate' },
        { status: 400 },
      )
    }

    const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1)
    const limit = Math.min(
      100,
      Math.max(1, parseInt(searchParams.get('limit') ?? '20', 10) || 20),
    )
    const skip = (page - 1) * limit

    const where: Record<string, unknown> = {}
    if (fromCurrency) where.fromCurrency = fromCurrency
    if (toCurrency) where.toCurrency = toCurrency
    if (source) where.source = source
    if (Object.keys(capturedAtFilter).length > 0) {
      where.capturedAt = capturedAtFilter
    }

    const [snapshots, total] = await Promise.all([
      prisma.fxRateSnapshot.findMany({
        where,
        orderBy: { capturedAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.fxRateSnapshot.count({ where }),
    ])

    const formatted = snapshots.map((s) => ({
      ...s,
      rate: Number(s.rate),
    }))

    return NextResponse.json({
      data: formatted,
      snapshots: formatted,
      latest: formatted[0] ?? null,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    })
  } catch (err) {
    console.error('[GET /api/fx-rate-snapshots]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * POST /api/fx-rate-snapshots
 * Records a new FX rate snapshot with currency validation and rate sanity checks.
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

    const fromCurrency =
      typeof body.fromCurrency === 'string'
        ? body.fromCurrency.trim().toUpperCase()
        : ''
    const toCurrency =
      typeof body.toCurrency === 'string'
        ? body.toCurrency.trim().toUpperCase()
        : ''
    const source =
      typeof body.source === 'string' ? body.source.trim() : ''
    const rawRate = body.rate
    const force = body.force === true

    if (!fromCurrency || !CURRENCY_REGEX.test(fromCurrency)) {
      return NextResponse.json(
        { error: 'Valid fromCurrency code is required (e.g. USDC, USD)' },
        { status: 400 },
      )
    }

    if (!toCurrency || !CURRENCY_REGEX.test(toCurrency)) {
      return NextResponse.json(
        { error: 'Valid toCurrency code is required (e.g. NGN, KES)' },
        { status: 400 },
      )
    }

    if (fromCurrency === toCurrency) {
      return NextResponse.json(
        { error: 'fromCurrency and toCurrency must be different' },
        { status: 400 },
      )
    }

    const rate = typeof rawRate === 'string' ? Number(rawRate) : Number(rawRate)
    if (!Number.isFinite(rate) || rate <= 0 || rate > MAX_RATE_VALUE) {
      return NextResponse.json(
        { error: `rate must be a positive number not exceeding ${MAX_RATE_VALUE}` },
        { status: 400 },
      )
    }

    if (!source) {
      return NextResponse.json(
        { error: 'source is required (e.g. coingecko, openexchangerates, manual)' },
        { status: 400 },
      )
    }

    let capturedAt: Date | undefined
    if (body.capturedAt !== undefined && body.capturedAt !== null) {
      const parsedDate = new Date(String(body.capturedAt))
      if (Number.isNaN(parsedDate.getTime())) {
        return NextResponse.json(
          { error: 'capturedAt must be a valid ISO date string' },
          { status: 400 },
        )
      }
      if (parsedDate.getTime() > Date.now() + 60_000) {
        return NextResponse.json(
          { error: 'capturedAt cannot be in the future' },
          { status: 400 },
        )
      }
      capturedAt = parsedDate
    }

    // Rate sanity check against the most recent snapshot for the same pair
    if (!force && typeof prisma.fxRateSnapshot.findFirst === 'function') {
      const previous = await prisma.fxRateSnapshot.findFirst({
        where: { fromCurrency, toCurrency },
        orderBy: { capturedAt: 'desc' },
      })

      if (previous && Number(previous.rate) > 0) {
        const prevRate = Number(previous.rate)
        const deviationRatio = Math.abs(rate - prevRate) / prevRate
        if (deviationRatio > MAX_DEVIATION_RATIO) {
          return NextResponse.json(
            {
              error: 'Rate deviates by more than 50% from previous snapshot; pass force=true to override',
              previousRate: prevRate,
              proposedRate: rate,
              deviationPct: Number((deviationRatio * 100).toFixed(2)),
            },
            { status: 422 },
          )
        }
      }
    }

    const snapshot = await prisma.fxRateSnapshot.create({
      data: {
        fromCurrency,
        toCurrency,
        rate,
        source,
        ...(capturedAt ? { capturedAt } : {}),
      },
    })

    const formatted = {
      ...snapshot,
      rate: Number(snapshot.rate),
    }

    return NextResponse.json(
      { snapshot: formatted, data: formatted },
      { status: 201 },
    )
  } catch (err) {
    console.error('[POST /api/fx-rate-snapshots]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
