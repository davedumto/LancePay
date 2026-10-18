import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    badgeDefinition: { findMany: vi.fn() },
    userBadge: { findMany: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

import { GET } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const NOW = new Date('2026-10-17T12:00:00.000Z')

const SAMPLE_BADGES = [
  {
    id: 'badge-rev-10k',
    name: '$10k Revenue Club',
    description: 'Earned $10,000+ in settled invoices',
    criteriaJson: { type: 'revenue', minRevenue: 10000 },
    imageUrl: 'https://cdn.lancepay.io/badges/rev10k.png',
    stellarAssetCode: 'LP10K',
    isActive: true,
    createdAt: NOW,
  },
  {
    id: 'badge-zero-dispute',
    name: 'Zero Dispute Pro',
    description: '10+ paid invoices with zero disputes',
    criteriaJson: { type: 'zero_disputes', minInvoices: 10, maxDisputes: 0 },
    imageUrl: 'https://cdn.lancepay.io/badges/zerodispute.png',
    stellarAssetCode: 'LPZERO',
    isActive: true,
    createdAt: NOW,
  },
]

function makeRequest(query = '', token: string | null = 'valid-token'): NextRequest {
  const suffix = query ? `?${query}` : ''
  return new NextRequest(`http://localhost/api/badges${suffix}`, {
    method: 'GET',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

describe('GET /api/badges (#1648)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' } as any)
    vi.mocked(prisma.badgeDefinition.findMany).mockResolvedValue(SAMPLE_BADGES as any)
    vi.mocked(prisma.userBadge.findMany).mockResolvedValue([
      {
        badgeId: 'badge-rev-10k',
        issuedAt: NOW,
        stellarTxHash: 'tx-123',
      },
    ] as any)
  })

  it('lists all active badge definitions with criteria metadata and earned status for the authenticated user', async () => {
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.total).toBe(2)
    expect(body.unearnedOnly).toBe(false)

    expect(body.badges[0]).toMatchObject({
      id: 'badge-rev-10k',
      name: '$10k Revenue Club',
      criteria: { type: 'revenue', minRevenue: 10000 },
      criteriaSummary: 'Complete at least $10,000 in paid invoice volume',
      earned: true,
      issuedAt: NOW.toISOString(),
    })

    expect(body.badges[1]).toMatchObject({
      id: 'badge-zero-dispute',
      name: 'Zero Dispute Pro',
      criteria: { type: 'zero_disputes', minInvoices: 10, maxDisputes: 0 },
      criteriaSummary: 'Complete at least 10 paid invoices with at most 0 disputes',
      earned: false,
      issuedAt: null,
    })
  })

  it('filters to only unearned badges when ?unearnedOnly=true is passed', async () => {
    const res = await GET(makeRequest('unearnedOnly=true'))
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.unearnedOnly).toBe(true)
    expect(body.badges).toHaveLength(1)
    expect(body.badges[0].id).toBe('badge-zero-dispute')
    expect(body.badges[0].earned).toBe(false)
  })

  it('returns 401 when ?unearnedOnly=true is requested without authentication', async () => {
    const res = await GET(makeRequest('unearnedOnly=true', null))
    expect(res.status).toBe(401)
  })

  it('allows public unauthenticated listing of all badge definitions when unearnedOnly is not set', async () => {
    const res = await GET(makeRequest('', null))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.badges).toHaveLength(2)
    expect(body.badges.every((b: any) => b.earned === false)).toBe(true)
  })

  it('returns 400 for invalid boolean query params', async () => {
    const res = await GET(makeRequest('unearnedOnly=invalid'))
    expect(res.status).toBe(400)
  })
})
