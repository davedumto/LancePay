import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  isValidTimezone,
  localMidnightToUtc,
  parseTzDateRange,
} from '../_lib/date-range'

// ── isValidTimezone ───────────────────────────────────────────────────────────

describe('isValidTimezone', () => {
  it('accepts UTC', () => expect(isValidTimezone('UTC')).toBe(true))
  it('accepts Africa/Lagos', () => expect(isValidTimezone('Africa/Lagos')).toBe(true))
  it('accepts America/Los_Angeles', () => expect(isValidTimezone('America/Los_Angeles')).toBe(true))
  it('accepts Europe/London', () => expect(isValidTimezone('Europe/London')).toBe(true))
  it('rejects empty string', () => expect(isValidTimezone('')).toBe(false))
  it('rejects made-up name', () => expect(isValidTimezone('Foo/Bar')).toBe(false))
  it('rejects plainly invalid string', () => expect(isValidTimezone('UTC+5')).toBe(false))
})

// ── localMidnightToUtc ────────────────────────────────────────────────────────

describe('localMidnightToUtc', () => {
  it('UTC midnight stays at UTC midnight', () => {
    const result = localMidnightToUtc('2024-01-15', 'UTC')
    expect(result.toISOString()).toBe('2024-01-15T00:00:00.000Z')
  })

  it('Africa/Lagos (UTC+1): midnight is 23:00 UTC the previous day', () => {
    const result = localMidnightToUtc('2024-01-15', 'Africa/Lagos')
    expect(result.toISOString()).toBe('2024-01-14T23:00:00.000Z')
  })

  it('America/Los_Angeles (PST = UTC-8): midnight is 08:00 UTC', () => {
    const result = localMidnightToUtc('2024-01-15', 'America/Los_Angeles')
    expect(result.toISOString()).toBe('2024-01-15T08:00:00.000Z')
  })

  it('DST spring-forward day (America/Los_Angeles 2024-03-10): midnight is 08:00 UTC (PST)', () => {
    // Clocks spring forward at 2am PST → 3am PDT on 2024-03-10
    // Midnight on Mar 10 is still PST (UTC-8) → 08:00 UTC
    const result = localMidnightToUtc('2024-03-10', 'America/Los_Angeles')
    expect(result.toISOString()).toBe('2024-03-10T08:00:00.000Z')
  })

  it('DST fall-back day (America/Los_Angeles 2024-11-03): midnight is 07:00 UTC (PDT)', () => {
    // Clocks fall back at 2am PDT → 1am PST on 2024-11-03
    // Midnight on Nov 3 is still PDT (UTC-7) → 07:00 UTC
    const result = localMidnightToUtc('2024-11-03', 'America/Los_Angeles')
    expect(result.toISOString()).toBe('2024-11-03T07:00:00.000Z')
  })
})

// ── parseTzDateRange ──────────────────────────────────────────────────────────

describe('parseTzDateRange', () => {
  it('defaults to UTC when no tz param and no user timezone', () => {
    const params = new URLSearchParams({ from: '2024-01-01', to: '2024-01-01' })
    const result = parseTzDateRange(params, null, new Date('2024-01-01T12:00:00Z'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.tz).toBe('UTC')
    expect(result.value.from.toISOString()).toBe('2024-01-01T00:00:00.000Z')
  })

  it('uses explicit ?tz= over user default', () => {
    const params = new URLSearchParams({
      from: '2024-01-15',
      to: '2024-01-15',
      tz: 'Africa/Lagos',
    })
    const result = parseTzDateRange(params, 'UTC', new Date('2024-01-15T12:00:00Z'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.tz).toBe('Africa/Lagos')
    // from should be 23:00 UTC on Jan 14 (Lagos midnight Jan 15)
    expect(result.value.from.toISOString()).toBe('2024-01-14T23:00:00.000Z')
  })

  it('falls back to user.timezone when no ?tz=', () => {
    const params = new URLSearchParams({ from: '2024-01-15', to: '2024-01-15' })
    const result = parseTzDateRange(params, 'America/Los_Angeles', new Date('2024-01-15T12:00:00Z'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.tz).toBe('America/Los_Angeles')
    expect(result.value.from.toISOString()).toBe('2024-01-15T08:00:00.000Z')
  })

  it('rejects unknown IANA name with error', () => {
    const params = new URLSearchParams({ tz: 'Fake/Zone', from: '2024-01-01', to: '2024-01-01' })
    const result = parseTzDateRange(params, null)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.fields).toHaveProperty('tz')
  })

  it('Africa/Lagos rollup: toExclusive is end of local day in UTC', () => {
    const params = new URLSearchParams({
      from: '2024-01-15',
      to: '2024-01-15',
      tz: 'Africa/Lagos',
    })
    const result = parseTzDateRange(params, null, new Date('2024-01-15T12:00:00Z'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Lagos Jan 15 = UTC Jan 14 23:00 → Jan 15 23:00 (exclusive)
    expect(result.value.toExclusive.toISOString()).toBe('2024-01-15T23:00:00.000Z')
    expect(result.value.days).toBe(1)
  })

  it('America/Los_Angeles rollup: from and toExclusive span one local day', () => {
    const params = new URLSearchParams({
      from: '2024-01-15',
      to: '2024-01-15',
      tz: 'America/Los_Angeles',
    })
    const result = parseTzDateRange(params, null, new Date('2024-01-15T20:00:00Z'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.from.toISOString()).toBe('2024-01-15T08:00:00.000Z')
    expect(result.value.toExclusive.toISOString()).toBe('2024-01-16T08:00:00.000Z')
  })

  it('DST transition: spring-forward day has correct boundaries', () => {
    // America/Los_Angeles 2024-03-10: PST → PDT at 2am
    const params = new URLSearchParams({
      from: '2024-03-10',
      to: '2024-03-10',
      tz: 'America/Los_Angeles',
    })
    const result = parseTzDateRange(params, null, new Date('2024-03-10T12:00:00Z'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Midnight PST = 08:00 UTC; end of day = midnight PDT Mar 11 = 07:00 UTC Mar 11
    expect(result.value.from.toISOString()).toBe('2024-03-10T08:00:00.000Z')
    expect(result.value.toExclusive.toISOString()).toBe('2024-03-11T07:00:00.000Z')
  })

  it('returns error for invalid date format', () => {
    const params = new URLSearchParams({ from: '15-01-2024', to: '2024-01-15', tz: 'UTC' })
    const result = parseTzDateRange(params, null)
    expect(result.ok).toBe(false)
  })

  it('returns error when from > to', () => {
    const params = new URLSearchParams({ from: '2024-01-20', to: '2024-01-15', tz: 'UTC' })
    const result = parseTzDateRange(params, null)
    expect(result.ok).toBe(false)
  })
})

// ── Route handler tests ───────────────────────────────────────────────────────

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn().mockResolvedValue({ userId: 'privy-1' }),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn().mockResolvedValue({ id: 'user-1', privyId: 'privy-1', timezone: null }),
    },
    transaction: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { amount: 500 }, _count: { id: 2 } }),
      count: vi.fn().mockResolvedValue(1),
    },
    invoice: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}))

import { GET as earningsGET } from '../analytics/earnings/route'
import { GET as withdrawalsGET } from '../analytics/withdrawals/route'
import { GET as topMonthsGET } from '../analytics/top-months/route'
import { prisma } from '@/lib/db'

function makeReq(searchParams: Record<string, string>) {
  const url = new URL('http://localhost/api/routes-b/analytics/earnings')
  for (const [k, v] of Object.entries(searchParams)) url.searchParams.set(k, v)
  return new Request(url.toString(), { headers: { authorization: 'Bearer tok' } }) as any
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    id: 'user-1',
    privyId: 'privy-1',
    timezone: null,
  } as any)
  vi.mocked(prisma.transaction.aggregate).mockResolvedValue({ _sum: { amount: 500 }, _count: { id: 2 } } as any)
  vi.mocked(prisma.transaction.count).mockResolvedValue(1)
  vi.mocked(prisma.invoice.findMany).mockResolvedValue([])
})

describe('GET /analytics/earnings with ?tz=', () => {
  it('defaults to UTC and returns 200', async () => {
    const res = await earningsGET(makeReq({ from: '2024-01-01', to: '2024-01-31' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.earnings.tz).toBe('UTC')
  })

  it('accepts Africa/Lagos and reflects timezone in response', async () => {
    const res = await earningsGET(
      makeReq({ from: '2024-01-01', to: '2024-01-31', tz: 'Africa/Lagos' }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.earnings.tz).toBe('Africa/Lagos')
  })

  it('returns 400 for invalid timezone', async () => {
    const res = await earningsGET(makeReq({ from: '2024-01-01', to: '2024-01-31', tz: 'Fake/Zone' }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.fields).toHaveProperty('tz')
  })

  it('uses user.timezone when no ?tz= param', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: 'user-1',
      timezone: 'America/Los_Angeles',
    } as any)
    const res = await earningsGET(makeReq({ from: '2024-01-15', to: '2024-01-15' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.earnings.tz).toBe('America/Los_Angeles')
  })
})

describe('GET /analytics/withdrawals with ?tz=', () => {
  it('returns 200 with UTC default', async () => {
    const res = await withdrawalsGET(makeReq({ from: '2024-01-01', to: '2024-01-31' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.withdrawals.tz).toBe('UTC')
  })

  it('returns 400 for invalid tz', async () => {
    const res = await withdrawalsGET(makeReq({ tz: 'Not/Valid' }))
    expect(res.status).toBe(400)
  })
})

describe('GET /analytics/top-months with ?tz=', () => {
  it('returns 200 with UTC default', async () => {
    const res = await topMonthsGET(makeReq({}))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('tz', 'UTC')
    expect(body).toHaveProperty('topMonths')
  })

  it('groups invoices by local month in Africa/Lagos', async () => {
    // Invoice paidAt just after midnight UTC would be the previous local day in UTC+1
    vi.mocked(prisma.invoice.findMany).mockResolvedValueOnce([
      // 23:30 UTC Dec 31 = 00:30 Jan 1 in Lagos → counts as Jan
      { amount: 100, paidAt: new Date('2024-12-31T23:30:00Z') },
      { amount: 200, paidAt: new Date('2024-01-15T10:00:00Z') },
    ] as any)
    const res = await topMonthsGET(makeReq({ tz: 'Africa/Lagos' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.tz).toBe('Africa/Lagos')
    // 23:30 UTC Dec 31 = Jan 1 00:30 Lagos → key '2025-01'
    const months = body.topMonths.map((m: any) => m.month)
    expect(months).toContain('2025-01')
  })

  it('returns 400 for invalid tz', async () => {
    const res = await topMonthsGET(makeReq({ tz: 'Bad/Zone' }))
    expect(res.status).toBe(400)
  })
})
