import { withRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { getCacheValue, setCacheValue, deleteCacheValue } from '../../_lib/cache'
import { onInvoicePaid } from '../../_lib/events'
import { isValidTimezone } from '../../_lib/date-range'
import { withCompression } from '../../_lib/with-compression'

const TOP_MONTHS_TTL_MS = 60 * 60 * 1000

let topMonthsEventHooked = false
const topMonthCacheKeysByUser = new Map<string, Set<string>>()

function ensureTopMonthsCacheInvalidationHook() {
  if (topMonthsEventHooked) return
  topMonthsEventHooked = true
  onInvoicePaid(({ userId }) => {
    for (const key of topMonthCacheKeysByUser.get(userId) ?? []) {
      deleteCacheValue(key)
    }
    topMonthCacheKeysByUser.delete(userId)
  })
}

async function GETHandler(request: NextRequest) {
  ensureTopMonthsCacheInvalidationHook()
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true, timezone: true },
    })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const url = new URL(request.url)
    const rawTz = url.searchParams.get('tz') ?? user.timezone ?? 'UTC'
    if (!isValidTimezone(rawTz)) {
      return NextResponse.json(
        { error: 'Invalid timezone', fields: { tz: `"${rawTz}" is not a valid IANA timezone name` } },
        { status: 400 },
      )
    }

    const cacheKey = `routes-b:analytics:top-months:${user.id}:${rawTz}`
    const cached = getCacheValue<{ topMonths: { month: string; earned: number }[]; tz: string }>(cacheKey)
    if (cached) {
      return withCompression(request, NextResponse.json(cached, { headers: { 'X-Cache': 'HIT' } }))
    }

    const paid = await prisma.invoice.findMany({
      where: { userId: user.id, status: 'paid' },
      select: { amount: true, paidAt: true },
    })

    const monthly: Record<string, number> = {}
    for (const inv of paid) {
      if (!inv.paidAt) continue
      const key = inv.paidAt.toLocaleDateString('en-CA', { timeZone: rawTz }).slice(0, 7)
      monthly[key] = (monthly[key] ?? 0) + Number(inv.amount)
    }

    const topMonths = Object.entries(monthly)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([month, earned]) => ({ month, earned: Number(earned.toFixed(2)) }))

    const payload = { topMonths, tz: rawTz }
    setCacheValue(cacheKey, payload, TOP_MONTHS_TTL_MS)
    const userKeys = topMonthCacheKeysByUser.get(user.id) ?? new Set<string>()
    userKeys.add(cacheKey)
    topMonthCacheKeysByUser.set(user.id, userKeys)
    return withCompression(request, NextResponse.json(payload, { headers: { 'X-Cache': 'MISS' } }))
  } catch (error) {
    console.error('Top months analytics error:', error)
    return NextResponse.json({ error: 'Failed to fetch analytics' }, { status: 500 })
  }
}

export const GET = withRequestId(GETHandler)
