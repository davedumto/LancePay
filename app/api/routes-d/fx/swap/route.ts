import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { getUsdToNgnRate } from '@/lib/exchange-rate'

const PLATFORM_FEE_BPS = 50 // 0.5 %
const MIN_SWAP_USD = 1
const MAX_SWAP_USD = 100_000
// Quote IDs issued by /fx/quote expire after 60 s; accept a small clock skew.
const QUOTE_MAX_AGE_MS = 90_000

type FxRateSnapshotDelegate = {
  create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

function getRateSnapshotDelegate(): FxRateSnapshotDelegate {
  return (prisma as unknown as { fxRateSnapshot: FxRateSnapshotDelegate }).fxRateSnapshot
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

function parseAmount(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < MIN_SWAP_USD || value > MAX_SWAP_USD) return null
    return value
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null
    const num = Number.parseFloat(trimmed)
    if (!Number.isFinite(num) || num < MIN_SWAP_USD || num > MAX_SWAP_USD) return null
    return num
  }
  return null
}

function parseQuoteId(value: unknown): { issuedAt: number } | null {
  // Quote IDs have the shape: q_{timestamp}_{userId8}
  if (typeof value !== 'string') return null
  const match = /^q_(\d+)_[a-z0-9]+$/.exec(value.trim())
  if (!match) return null
  const issuedAt = Number.parseInt(match[1]!, 10)
  if (!Number.isFinite(issuedAt)) return null
  return { issuedAt }
}

export async function POST(request: NextRequest) {
  const user = await getAuthenticatedUser(request)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const payload = (body ?? {}) as Record<string, unknown>

  const amount = parseAmount(payload.amountUsd)
  if (amount === null) {
    return NextResponse.json(
      { error: `amountUsd must be a number between ${MIN_SWAP_USD} and ${MAX_SWAP_USD} with up to 2 decimal places.` },
      { status: 400 },
    )
  }

  // If caller supplies a quoteId, validate it hasn't expired.
  if (payload.quoteId !== undefined) {
    const parsed = parseQuoteId(payload.quoteId)
    if (!parsed) {
      return NextResponse.json({ error: 'Invalid quoteId format.' }, { status: 400 })
    }
    if (Date.now() - parsed.issuedAt > QUOTE_MAX_AGE_MS) {
      return NextResponse.json(
        { error: 'Quote has expired. Please request a new quote from /fx/quote.' },
        { status: 409 },
      )
    }
  }

  const rateData = await getUsdToNgnRate()
  const effectiveRate = rateData.rate * (1 - PLATFORM_FEE_BPS / 10_000)
  const ngnAmount = amount * effectiveRate
  const feeUsd = amount * (PLATFORM_FEE_BPS / 10_000)

  // Persist a rate snapshot so the swap is auditable even if rates change.
  const snapshotDelegate = getRateSnapshotDelegate()
  const snapshot = await snapshotDelegate.create({
    data: {
      fromCurrency: 'USD',
      toCurrency: 'NGN',
      rate: effectiveRate,
      source: rateData.fallback ? 'fallback' : rateData.fromCache ? 'cache' : 'live',
      capturedAt: new Date(),
    },
    select: { id: true },
  })

  const executedAt = new Date().toISOString()

  return NextResponse.json(
    {
      swapId: `swap_${Date.now()}_${user.id.slice(0, 8)}`,
      from: { currency: 'USD', amount: Number(amount.toFixed(2)) },
      to: { currency: 'NGN', amount: Number(ngnAmount.toFixed(2)) },
      effectiveRate: Number(effectiveRate.toFixed(6)),
      fee: { currency: 'USD', amount: Number(feeUsd.toFixed(2)), bps: PLATFORM_FEE_BPS },
      rateSnapshotId: (snapshot as Record<string, unknown>).id,
      rateSource: rateData.fallback ? 'fallback' : rateData.fromCache ? 'cache' : 'live',
      executedAt,
    },
    { status: 201 },
  )
}
