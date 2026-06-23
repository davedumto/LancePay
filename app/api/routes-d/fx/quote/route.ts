import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { getUsdToNgnRate } from '@/lib/exchange-rate'

/**
 * FX quote validity. Keep this short so a stale quote can't be replayed
 * against a moved rate. 60 seconds matches the typical retail quote
 * window used by anchors LancePay integrates with.
 */
const QUOTE_TTL_MS = 60_000

/**
 * Spread the platform takes on top of the mid-market rate. Expressed
 * in basis points so it lines up with how the rest of the codebase
 * talks about fees (`platform_fee_bps`).
 */
const PLATFORM_FEE_BPS = 50 // 0.5%

const CURRENCY_PATTERN = /^[A-Z]{3}$/

interface SupportedPair {
  from: 'USD'
  to: 'NGN'
}

const SUPPORTED: Array<SupportedPair> = [{ from: 'USD', to: 'NGN' }]

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

function parseAmount(raw: string | null): number | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null
  const num = Number.parseFloat(trimmed)
  if (!Number.isFinite(num) || num <= 0 || num > 10_000_000) return null
  return num
}

function isSupported(from: string, to: string): boolean {
  return SUPPORTED.some((pair) => pair.from === from && pair.to === to)
}

export async function GET(request: NextRequest) {
  const user = await getAuthenticatedUser(request)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = request.nextUrl
  const from = parseCurrency(url.searchParams.get('from'))
  const to = parseCurrency(url.searchParams.get('to'))
  const amount = parseAmount(url.searchParams.get('amount'))

  if (!from || !to) {
    return NextResponse.json(
      { error: 'Both "from" and "to" must be ISO 4217 currency codes (3 uppercase letters).' },
      { status: 400 },
    )
  }

  if (from === to) {
    return NextResponse.json(
      { error: '"from" and "to" must be different currency codes.' },
      { status: 400 },
    )
  }

  if (amount === null) {
    return NextResponse.json(
      { error: '"amount" must be a positive number with up to 2 decimal places.' },
      { status: 400 },
    )
  }

  if (!isSupported(from, to)) {
    return NextResponse.json(
      {
        error: `FX pair ${from}/${to} is not supported.`,
        supported: SUPPORTED.map((p) => `${p.from}/${p.to}`),
      },
      { status: 400 },
    )
  }

  // Only USD/NGN is wired today via lib/exchange-rate.ts. As the lib
  // grows to cover more pairs, swap the SUPPORTED guard above.
  const midRate = await getUsdToNgnRate()

  // Apply the spread on top of the mid-market rate. Buying NGN, so the
  // user receives slightly less than the mid rate.
  const effectiveRate = midRate.rate * (1 - PLATFORM_FEE_BPS / 10_000)
  const grossAmount = amount * midRate.rate
  const feeAmount = grossAmount - amount * effectiveRate
  const netAmount = amount * effectiveRate

  const issuedAt = Date.now()
  const expiresAt = issuedAt + QUOTE_TTL_MS

  return NextResponse.json({
    quoteId: `q_${issuedAt}_${user.id.slice(0, 8)}`,
    from,
    to,
    amount: amount.toFixed(2),
    midRate: midRate.rate,
    effectiveRate: Number(effectiveRate.toFixed(6)),
    fee: {
      amount: Number(feeAmount.toFixed(2)),
      currency: to,
      bps: PLATFORM_FEE_BPS,
    },
    netAmount: Number(netAmount.toFixed(2)),
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    source: midRate.fallback ? 'fallback' : midRate.fromCache ? 'cache' : 'live',
  })
}
