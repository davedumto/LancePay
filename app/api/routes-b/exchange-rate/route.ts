import { NextRequest, NextResponse } from 'next/server'
import { getCachedValue, setCachedValue } from '../_lib/cache'

const EXCHANGE_RATE_TTL_MS = 60_000
const MAX_STALE_SECONDS = 3600

type CachedRate = {
  value: number
  fetchedAt: string
}

function canBypassCache(request: NextRequest) {
  const bypassParam = new URL(request.url).searchParams.get('bypassCache')
  if (bypassParam !== 'true') {
    return false
  }

  const configuredToken = process.env.ROUTES_B_INTERNAL_BYPASS_TOKEN
  if (!configuredToken) {
    return false
  }

  const providedToken = request.headers.get('x-routes-b-internal-bypass-token')
  return providedToken === configuredToken
}

export async function GET(request: NextRequest) {
  const searchParams = new URL(request.url).searchParams
  const from = (searchParams.get('from') || 'USD').toUpperCase()
  const to = (searchParams.get('to') || 'NGN').toUpperCase()
  const cacheKey = `exchange-rate:${from}:${to}`

  try {
    if (!canBypassCache(request)) {
      const cached = getCachedValue<CachedRate>(cacheKey)
      if (cached) {
        return NextResponse.json(
          {
            rate: {
              from,
              to,
              value: cached.value,
              source: 'open.er-api.com',
              fetchedAt: cached.fetchedAt,
            },
          },
          {
            status: 200,
            headers: { 'X-Cache': 'HIT' },
          },
        )
      }
    }

    const res = await fetch(`https://open.er-api.com/v6/latest/${from}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
    })

    if (!res.ok) {
      throw new Error('Failed to fetch exchange rate')
    }

    const data = await res.json()
    const rate = data?.rates?.[to]

    if (typeof rate !== 'number') {
      throw new Error('Invalid rate format')
    }

    const fetchedAt = new Date().toISOString()
    setCachedValue(cacheKey, { value: rate, fetchedAt }, EXCHANGE_RATE_TTL_MS)

    return NextResponse.json(
      {
        rate: {
          from,
          to,
          value: rate,
          source: 'open.er-api.com',
          fetchedAt,
        },
      },
      {
        status: 200,
        headers: { 'X-Cache': 'MISS' },
      },
    )
  } catch (error) {
    console.error('Exchange rate fetch error:', error)

    const stale = getCachedValue<CachedRate>(cacheKey)
    if (stale) {
      const stalenessSeconds = Math.floor((Date.now() - new Date(stale.fetchedAt).getTime()) / 1000)
      if (stalenessSeconds <= MAX_STALE_SECONDS) {
        return NextResponse.json(
          {
            rate: {
              from,
              to,
              value: stale.value,
              source: 'open.er-api.com',
              fetchedAt: stale.fetchedAt,
            },
            stalenessSeconds,
          },
          { status: 200, headers: { 'X-Stale': 'true' } },
        )
      }
    }

    return NextResponse.json(
      {
        error: 'Unable to fetch exchange rate. Please try again.',
        code: 'RATE_UNAVAILABLE',
      },
      { status: 503 },
    )
  }
}
