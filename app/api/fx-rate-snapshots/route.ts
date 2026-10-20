import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const SUPPORTED_CURRENCIES = new Set([
  'USD',
  'EUR',
  'GBP',
  'CAD',
  'AUD',
  'JPY',
  'USDC',
  'XLM',
  'NGN',
  'KES',
  'GHS',
])

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const fromCurrency = searchParams.get('fromCurrency')?.toUpperCase()
    const toCurrency = searchParams.get('toCurrency')?.toUpperCase()
    const startDate = searchParams.get('startDate')
    const endDate = searchParams.get('endDate')
    const parsedLimit = Number(searchParams.get('limit'))
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 100) : 50

    const where: any = {}
    if (fromCurrency) where.fromCurrency = fromCurrency
    if (toCurrency) where.toCurrency = toCurrency

    if (startDate || endDate) {
      where.capturedAt = {}
      if (startDate) {
        const start = new Date(startDate)
        if (!Number.isNaN(start.getTime())) where.capturedAt.gte = start
      }
      if (endDate) {
        const end = new Date(endDate)
        if (!Number.isNaN(end.getTime())) where.capturedAt.lte = end
      }
    }

    const snapshots = await prisma.fxRateSnapshot.findMany({
      where,
      orderBy: { capturedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        fromCurrency: true,
        toCurrency: true,
        rate: true,
        source: true,
        capturedAt: true,
        createdAt: true,
      },
    })

    return NextResponse.json({
      snapshots: snapshots.map((s) => ({
        ...s,
        rate: s.rate.toString(),
        capturedAt: s.capturedAt.toISOString(),
        createdAt: s.createdAt.toISOString(),
      })),
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/fx-rate-snapshots error')
    return NextResponse.json({ error: 'Failed to fetch FX rate snapshots' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true, role: true },
    })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    if (user.role !== 'admin' && user.role !== 'compliance') {
      return NextResponse.json(
        { error: 'Forbidden: admin or internal access required' },
        { status: 403 },
      )
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { fromCurrency, toCurrency, rate, source, capturedAt } = (body ?? {}) as {
      fromCurrency?: string
      toCurrency?: string
      rate?: number | string
      source?: string
      capturedAt?: string
    }

    if (!fromCurrency || typeof fromCurrency !== 'string') {
      return NextResponse.json({ error: 'fromCurrency is required' }, { status: 400 })
    }
    if (!toCurrency || typeof toCurrency !== 'string') {
      return NextResponse.json({ error: 'toCurrency is required' }, { status: 400 })
    }

    const from = fromCurrency.trim().toUpperCase()
    const to = toCurrency.trim().toUpperCase()

    if (!SUPPORTED_CURRENCIES.has(from) || !SUPPORTED_CURRENCIES.has(to)) {
      return NextResponse.json(
        { error: 'Unsupported currency. Must be one of the supported currencies' },
        { status: 400 },
      )
    }

    const numRate = Number(rate)
    if (!Number.isFinite(numRate) || numRate <= 0) {
      return NextResponse.json({ error: 'rate must be a positive number' }, { status: 400 })
    }

    const capturedDate = capturedAt ? new Date(capturedAt) : new Date()
    if (Number.isNaN(capturedDate.getTime())) {
      return NextResponse.json({ error: 'capturedAt must be a valid ISO date' }, { status: 400 })
    }

    const snapshot = await prisma.fxRateSnapshot.create({
      data: {
        fromCurrency: from,
        toCurrency: to,
        rate: numRate,
        source: typeof source === 'string' && source.trim() ? source.trim() : 'manual',
        capturedAt: capturedDate,
      },
    })

    return NextResponse.json(
      {
        snapshot: {
          ...snapshot,
          rate: snapshot.rate.toString(),
          capturedAt: snapshot.capturedAt.toISOString(),
          createdAt: snapshot.createdAt.toISOString(),
        },
      },
      { status: 201 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/fx-rate-snapshots error')
    return NextResponse.json({ error: 'Failed to record FX rate snapshot' }, { status: 500 })
  }
}
