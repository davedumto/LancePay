import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const DEFAULT_THRESHOLD_MINUTES = 15
const CURRENCY_REGEX = /^[A-Z]{2,10}$/

export interface PairStalenessStatus {
  pair: string
  fromCurrency: string
  toCurrency: string
  latestSnapshotId: string | null
  rate: number | null
  source: string | null
  capturedAt: Date | string | null
  ageSeconds: number | null
  ageMinutes: number | null
  thresholdMinutes: number
  thresholdSeconds: number
  isStale: boolean
  status: 'fresh' | 'stale' | 'missing'
}

function extractToken(req: NextRequest): string | null {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  return authHeader.slice(7).trim() || null
}

/**
 * GET /api/fx-rate-snapshots/staleness-check
 * Checks whether the latest FX rate snapshots for tracked currency pairs exceed
 * the configured staleness threshold (default: 15 minutes).
 */
export async function GET(req: NextRequest) {
  try {
    const token = extractToken(req)
    const claims = token ? await verifyAuthToken(token) : null
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(req.url)
    const rawThresholdMinutes =
      searchParams.get('maxAgeMinutes') ??
      searchParams.get('thresholdMinutes') ??
      null
    const rawThresholdSeconds = searchParams.get('thresholdSeconds') ?? null

    let thresholdMinutes = DEFAULT_THRESHOLD_MINUTES
    let thresholdSeconds = DEFAULT_THRESHOLD_MINUTES * 60

    if (rawThresholdMinutes !== null) {
      const parsed = Number(rawThresholdMinutes)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return NextResponse.json(
          { error: 'maxAgeMinutes must be a positive number' },
          { status: 400 },
        )
      }
      thresholdMinutes = parsed
      thresholdSeconds = Math.round(parsed * 60)
    } else if (rawThresholdSeconds !== null) {
      const parsed = Number(rawThresholdSeconds)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return NextResponse.json(
          { error: 'thresholdSeconds must be a positive number' },
          { status: 400 },
        )
      }
      thresholdSeconds = Math.round(parsed)
      thresholdMinutes = Number((parsed / 60).toFixed(2))
    }

    let fromCurrency = (
      searchParams.get('fromCurrency') ??
      searchParams.get('from') ??
      ''
    )
      .trim()
      .toUpperCase()
    let toCurrency = (
      searchParams.get('toCurrency') ??
      searchParams.get('to') ??
      ''
    )
      .trim()
      .toUpperCase()

    const pairParam = searchParams.get('pair')?.trim().toUpperCase()
    if (pairParam) {
      const parts = pairParam.split(/[\/\-_]/)
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        return NextResponse.json(
          { error: 'pair must be formatted as FROM/TO (e.g. USDC/NGN)' },
          { status: 400 },
        )
      }
      fromCurrency = parts[0]
      toCurrency = parts[1]
    }

    if (fromCurrency && !CURRENCY_REGEX.test(fromCurrency)) {
      return NextResponse.json(
        { error: 'Invalid fromCurrency code' },
        { status: 400 },
      )
    }

    if (toCurrency && !CURRENCY_REGEX.test(toCurrency)) {
      return NextResponse.json(
        { error: 'Invalid toCurrency code' },
        { status: 400 },
      )
    }

    const where: Record<string, string> = {}
    if (fromCurrency) where.fromCurrency = fromCurrency
    if (toCurrency) where.toCurrency = toCurrency

    const snapshots = await prisma.fxRateSnapshot.findMany({
      where,
      orderBy: { capturedAt: 'desc' },
    })

    const nowMs = Date.now()
    const latestByPair = new Map<string, (typeof snapshots)[number]>()

    for (const snap of snapshots) {
      const key = `${snap.fromCurrency.toUpperCase()}/${snap.toCurrency.toUpperCase()}`
      if (!latestByPair.has(key)) {
        latestByPair.set(key, snap)
      }
    }

    const pairs: PairStalenessStatus[] = []

    if (latestByPair.size === 0 && fromCurrency && toCurrency) {
      pairs.push({
        pair: `${fromCurrency}/${toCurrency}`,
        fromCurrency,
        toCurrency,
        latestSnapshotId: null,
        rate: null,
        source: null,
        capturedAt: null,
        ageSeconds: null,
        ageMinutes: null,
        thresholdMinutes,
        thresholdSeconds,
        isStale: true,
        status: 'missing',
      })
    } else {
      for (const [pairKey, snap] of latestByPair.entries()) {
        const capturedMs = new Date(snap.capturedAt).getTime()
        const ageSeconds = Math.max(0, Math.floor((nowMs - capturedMs) / 1000))
        const ageMinutes = Number((ageSeconds / 60).toFixed(2))
        const isStale = ageSeconds > thresholdSeconds

        pairs.push({
          pair: pairKey,
          fromCurrency: snap.fromCurrency.toUpperCase(),
          toCurrency: snap.toCurrency.toUpperCase(),
          latestSnapshotId: snap.id,
          rate: Number(snap.rate),
          source: snap.source,
          capturedAt: snap.capturedAt,
          ageSeconds,
          ageMinutes,
          thresholdMinutes,
          thresholdSeconds,
          isStale,
          status: isStale ? 'stale' : 'fresh',
        })
      }
    }

    const stalePairs = pairs.filter((p) => p.isStale)
    const freshPairs = pairs.filter((p) => !p.isStale)
    const missingCount = pairs.filter((p) => p.status === 'missing').length
    const isStale = stalePairs.length > 0

    return NextResponse.json({
      isStale,
      healthy: !isStale,
      thresholdMinutes,
      thresholdSeconds,
      checkedAt: new Date(nowMs).toISOString(),
      pairs,
      stalePairs,
      freshPairs,
      summary: {
        totalPairs: pairs.length,
        freshCount: freshPairs.length,
        staleCount: stalePairs.length,
        missingCount,
        healthy: !isStale,
        thresholdMinutes,
        thresholdSeconds,
      },
    })
  } catch (err) {
    console.error('[GET /api/fx-rate-snapshots/staleness-check]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
