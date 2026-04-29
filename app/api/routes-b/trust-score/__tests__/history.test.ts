import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

import {
  ALLOWED_RANGE_DAYS,
  MAX_RETENTION_DAYS,
  getTrustScoreHistory,
  isAllowedRange,
  recordTrustScoreSnapshot,
  resetTrustScoreHistoryStore,
} from '../../_lib/trust-score-history'

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    apiKey: { findUnique: vi.fn(), update: vi.fn() },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFindUnique = vi.mocked(prisma.user.findUnique)

beforeEach(() => {
  vi.resetAllMocks()
  resetTrustScoreHistoryStore()
  mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
  mockedUserFindUnique.mockResolvedValue({ id: 'user-1', role: 'user' } as never)
})

describe('trust-score history store', () => {
  it('returns an empty array before any snapshot is recorded', () => {
    expect(getTrustScoreHistory('user-1', 30)).toEqual([])
  })

  it('records a snapshot per day and replaces same-day entries with the latest score', () => {
    const day1 = new Date('2026-04-29T00:00:00Z')
    recordTrustScoreSnapshot('user-1', 60, day1)
    // recompute later the same day overwrites the day's score
    recordTrustScoreSnapshot('user-1', 65, new Date('2026-04-29T22:00:00Z'))

    const history = getTrustScoreHistory('user-1', 30, day1)
    expect(history).toEqual([{ date: '2026-04-29', score: 65 }])
  })

  it('builds up history across multiple days in ascending order', () => {
    recordTrustScoreSnapshot('user-1', 50, new Date('2026-04-27T00:00:00Z'))
    recordTrustScoreSnapshot('user-1', 55, new Date('2026-04-28T00:00:00Z'))
    recordTrustScoreSnapshot('user-1', 60, new Date('2026-04-29T00:00:00Z'))

    const history = getTrustScoreHistory('user-1', 30, new Date('2026-04-29T00:00:00Z'))
    expect(history).toEqual([
      { date: '2026-04-27', score: 50 },
      { date: '2026-04-28', score: 55 },
      { date: '2026-04-29', score: 60 },
    ])
  })

  it('caps retention at 365 days, dropping the oldest entries first', () => {
    const start = new Date('2025-04-29T00:00:00Z')
    for (let i = 0; i < MAX_RETENTION_DAYS + 5; i += 1) {
      const day = new Date(start)
      day.setUTCDate(start.getUTCDate() + i)
      recordTrustScoreSnapshot('user-1', 50 + (i % 50), day)
    }

    const lastDay = new Date(start)
    lastDay.setUTCDate(start.getUTCDate() + MAX_RETENTION_DAYS + 4)

    const history = getTrustScoreHistory('user-1', 365, lastDay)
    expect(history).toHaveLength(MAX_RETENTION_DAYS)
    // oldest 5 days were dropped
    expect(history[0].date).toBe('2025-05-04')
  })

  it('range filter returns only entries within the requested window', () => {
    recordTrustScoreSnapshot('user-1', 40, new Date('2026-01-01T00:00:00Z'))
    recordTrustScoreSnapshot('user-1', 50, new Date('2026-04-01T00:00:00Z'))
    recordTrustScoreSnapshot('user-1', 60, new Date('2026-04-29T00:00:00Z'))

    const last30 = getTrustScoreHistory('user-1', 30, new Date('2026-04-29T00:00:00Z'))
    expect(last30.map(s => s.date)).toEqual(['2026-04-01', '2026-04-29'])

    const last90 = getTrustScoreHistory('user-1', 90, new Date('2026-04-29T00:00:00Z'))
    expect(last90.map(s => s.date)).toEqual(['2026-04-01', '2026-04-29'])

    const last365 = getTrustScoreHistory('user-1', 365, new Date('2026-04-29T00:00:00Z'))
    expect(last365.map(s => s.date)).toEqual(['2026-01-01', '2026-04-01', '2026-04-29'])
  })

  it('does not leak history across users', () => {
    recordTrustScoreSnapshot('user-a', 40, new Date('2026-04-29T00:00:00Z'))
    expect(getTrustScoreHistory('user-b', 30)).toEqual([])
  })

  it('isAllowedRange only accepts 30, 90, or 365', () => {
    expect(ALLOWED_RANGE_DAYS).toEqual([30, 90, 365])
    expect(isAllowedRange(30)).toBe(true)
    expect(isAllowedRange(90)).toBe(true)
    expect(isAllowedRange(365)).toBe(true)
    expect(isAllowedRange(60)).toBe(false)
    expect(isAllowedRange('30')).toBe(false)
  })
})

describe('GET /api/routes-b/trust-score/history', () => {
  it('returns an empty history for a fresh user', async () => {
    const { GET } = await import('../history/route')
    const request = new NextRequest('http://localhost/api/routes-b/trust-score/history', {
      headers: { authorization: 'Bearer token' },
    })

    const res = await GET(request)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.history).toEqual([])
    expect(json.days).toBe(30)
  })

  it('returns recorded snapshots in ascending date order', async () => {
    recordTrustScoreSnapshot('user-1', 50, new Date('2026-04-27T00:00:00Z'))
    recordTrustScoreSnapshot('user-1', 55, new Date('2026-04-28T00:00:00Z'))
    recordTrustScoreSnapshot('user-1', 60, new Date('2026-04-29T00:00:00Z'))

    const { GET } = await import('../history/route')
    const request = new NextRequest('http://localhost/api/routes-b/trust-score/history', {
      headers: { authorization: 'Bearer token' },
    })

    const res = await GET(request)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.history.map((s: { date: string }) => s.date)).toEqual([
      '2026-04-27',
      '2026-04-28',
      '2026-04-29',
    ])
  })

  it('rejects an out-of-range days value', async () => {
    const { GET } = await import('../history/route')
    const request = new NextRequest('http://localhost/api/routes-b/trust-score/history?days=60', {
      headers: { authorization: 'Bearer token' },
    })

    const res = await GET(request)
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.code).toBe('INVALID_RANGE')
  })

  it('honors the allowed days values', async () => {
    const { GET } = await import('../history/route')
    for (const days of ALLOWED_RANGE_DAYS) {
      const request = new NextRequest(
        `http://localhost/api/routes-b/trust-score/history?days=${days}`,
        { headers: { authorization: 'Bearer token' } },
      )
      const res = await GET(request)
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.days).toBe(days)
    }
  })

  it('returns 403 without a valid token (parity with /trust-score)', async () => {
    mockedVerify.mockResolvedValue(null as never)

    const { GET } = await import('../history/route')
    const request = new NextRequest('http://localhost/api/routes-b/trust-score/history', {})

    const res = await GET(request)
    expect(res.status).toBe(403)
  })
})
