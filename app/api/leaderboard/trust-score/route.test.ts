import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    userTrustScore: {
      findMany: vi.fn(),
    },
  },
}))

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import { GET } from './route'

function makeGetRequest(query = ''): NextRequest {
  const url = `http://localhost/api/leaderboard/trust-score${
    query ? `?${query}` : ''
  }`
  return new NextRequest(url, { method: 'GET' })
}

describe('GET /api/leaderboard/trust-score', () => {
  const mockTrustScoreRows = [
    // Opted-out user with high score (must be excluded!)
    {
      userId: 'user-opted-out',
      score: 99,
      totalVolumeUsdc: '999999.00',
      successfulInvoices: 500,
      user: {
        id: 'user-opted-out',
        email: 'hidden@secret.io',
        name: 'Hidden Whale',
        publicVisibility: false,
        leaderboardOptIn: false,
        createdAt: new Date('2024-01-01T00:00:00Z'),
        userBadges: [],
      },
    },
    // Rank 1: Score 95, Volume 50,000, 'handle' mode -> "Ada L."
    {
      userId: 'user-1',
      score: 95,
      totalVolumeUsdc: '50000.00',
      successfulInvoices: 45,
      user: {
        id: 'user-1',
        email: 'ada@private-email.org',
        phone: '+2348000000001',
        name: 'Ada Lovelace',
        publicVisibility: true,
        leaderboardOptIn: true,
        privacyPreference: 'handle',
        avatarUrl: 'https://cdn.lancepay.io/ada.png',
        createdAt: new Date('2025-01-10T00:00:00Z'),
        userBadges: [{ id: 'ub-1' }, { id: 'ub-2' }],
      },
    },
    // Rank 2: Tied Score 90, higher volume (30,000), 'anonymous' mode -> "Freelancer #..."
    {
      userId: 'user-2',
      score: 90,
      totalVolumeUsdc: '30000.00',
      successfulInvoices: 30,
      user: {
        id: 'user-2',
        email: 'anon@private-email.org',
        name: 'Satoshi Nakamoto',
        publicVisibility: true,
        leaderboardOptIn: true,
        privacyPreference: 'anonymous',
        avatarUrl: 'https://cdn.lancepay.io/satoshi.png',
        createdAt: new Date('2025-03-01T00:00:00Z'),
        userBadges: [{ id: 'ub-3' }],
      },
    },
    // Rank 3: Tied Score 90, lower volume (12,000), older account (2024-06-01), 'initials' mode -> "G. H."
    {
      userId: 'user-3',
      score: 90,
      totalVolumeUsdc: '12000.00',
      successfulInvoices: 20,
      user: {
        id: 'user-3',
        email: 'grace@private-email.org',
        name: 'Grace Hopper',
        publicVisibility: true,
        leaderboardOptIn: true,
        privacyPreference: 'initials',
        createdAt: new Date('2024-06-01T00:00:00Z'),
        userBadges: [],
      },
    },
    // Rank 4: Tied Score 90, tied volume (12,000), tied invoices (20), newer account (2025-06-01)
    {
      userId: 'user-4',
      score: 90,
      totalVolumeUsdc: '12000.00',
      successfulInvoices: 20,
      user: {
        id: 'user-4',
        email: 'alan@private-email.org',
        name: 'Alan Turing',
        publicVisibility: true,
        leaderboardOptIn: true,
        privacyPreference: 'handle',
        createdAt: new Date('2025-06-01T00:00:00Z'),
        userBadges: [],
      },
    },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.userTrustScore.findMany.mockResolvedValue(mockTrustScoreRows)
  })

  it('excludes users who have not opted in, formats handles per privacy preference, and never leaks email or PII', async () => {
    const res = await GET(makeGetRequest())
    expect(res.status).toBe(200)
    const body = await res.json()

    // Opted-out user (score 99) is excluded; 4 opted-in users returned
    expect(body.leaderboard).toHaveLength(4)
    expect(body.pagination.totalOptedIn).toBe(4)

    // Privacy preferences respected
    expect(body.leaderboard[0].displayHandle).toBe('Ada L.')
    expect(body.leaderboard[0].privacyMode).toBe('handle')
    expect(body.leaderboard[0].badgeCount).toBe(2)

    expect(body.leaderboard[1].displayHandle).toMatch(/^Freelancer #[0-9A-F]{6}$/)
    expect(body.leaderboard[1].privacyMode).toBe('anonymous')
    expect(body.leaderboard[1].avatarUrl).toBeNull()

    expect(body.leaderboard[2].displayHandle).toBe('G. H.')
    expect(body.leaderboard[2].privacyMode).toBe('initials')

    // Never leaks email, phone, or raw userId
    const rawJson = JSON.stringify(body)
    expect(rawJson).not.toContain('private-email.org')
    expect(rawJson).not.toContain('+2348000000001')
    expect(rawJson).not.toContain('Satoshi Nakamoto')
    expect(rawJson).not.toContain('Hidden Whale')
  })

  it('breaks score ties deterministically by completed volume and account age', async () => {
    const res = await GET(makeGetRequest())
    const { leaderboard } = await res.json()

    // Rank 1: Score 95
    // Rank 2: Score 90, Volume 30,000
    // Rank 3: Score 90, Volume 12,000, Created 2024-06-01 (older account wins tie)
    // Rank 4: Score 90, Volume 12,000, Created 2025-06-01
    expect(leaderboard.map((e: { rank: number }) => e.rank)).toEqual([
      1, 2, 3, 4,
    ])
    expect(leaderboard[1].totalVolumeUsdc).toBe(30000)
    expect(leaderboard[2].displayHandle).toBe('G. H.')
    expect(leaderboard[3].displayHandle).toBe('Alan T.')
  })

  it('supports cursor and offset pagination while preserving global rank numbers', async () => {
    const page1Res = await GET(makeGetRequest('limit=2'))
    expect(page1Res.status).toBe(200)
    const page1 = await page1Res.json()
    expect(page1.leaderboard).toHaveLength(2)
    expect(page1.leaderboard[0].rank).toBe(1)
    expect(page1.leaderboard[1].rank).toBe(2)
    expect(page1.pagination.hasMore).toBe(true)
    expect(page1.pagination.nextCursor).toBeTruthy()

    const page2Res = await GET(
      makeGetRequest(
        `limit=2&cursor=${encodeURIComponent(page1.pagination.nextCursor)}`,
      ),
    )
    expect(page2Res.status).toBe(200)
    const page2 = await page2Res.json()
    expect(page2.leaderboard).toHaveLength(2)
    expect(page2.leaderboard[0].rank).toBe(3)
    expect(page2.leaderboard[1].rank).toBe(4)
    expect(page2.pagination.hasMore).toBe(false)
    expect(page2.pagination.nextCursor).toBeNull()
  })
})
