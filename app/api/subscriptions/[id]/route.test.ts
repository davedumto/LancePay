import { describe, it, expect, beforeEach, vi } from 'vitest'
import { GET } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    subscription: { findFirst: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))
vi.mock('@/lib/proration', () => ({
  billingPeriodStart: vi.fn((end, freq, interval) => {
    // Simple mock: subtract 1 month for monthly
    const date = new Date(end)
    if (freq === 'monthly') {
      date.setMonth(date.getMonth() - interval)
    }
    return date
  }),
}))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUserId = 'user-123'
const mockPrivyId = 'privy-123'
const mockSubscriptionId = 'sub-123'
const params = { id: mockSubscriptionId }

function makeRequest() {
  return new NextRequest(`http://localhost:3000/api/subscriptions/${mockSubscriptionId}`, {
    method: 'GET',
    headers: { Authorization: 'Bearer valid-token' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: mockPrivyId } as never)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: mockUserId } as never)
})

describe('GET /api/subscriptions/[id]', () => {
  it('returns the subscription for the authenticated owner', async () => {
    const nextGenDate = new Date('2026-11-17')
    const mockSubscription = {
      id: mockSubscriptionId,
      userId: mockUserId,
      clientEmail: 'client@example.com',
      clientName: 'Acme Corp',
      description: 'Monthly service',
      amount: 100,
      currency: 'USD',
      frequency: 'monthly',
      interval: 1,
      status: 'active',
      nextGenerationDate: nextGenDate,
      lastGeneratedAt: new Date('2026-10-17'),
      createdAt: new Date('2026-08-17'),
      updatedAt: new Date('2026-10-17'),
    }
    vi.mocked(prisma.subscription.findFirst).mockResolvedValue(mockSubscription as never)

    const res = await GET(makeRequest(), { params })
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.subscription.id).toBe(mockSubscriptionId)
    expect(data.subscription.amount).toBe(100)
    expect(data.subscription.status).toBe('active')
  })

  it('includes billing period for active subscriptions', async () => {
    const nextGenDate = new Date('2026-11-17')
    const mockSubscription = {
      id: mockSubscriptionId,
      userId: mockUserId,
      clientEmail: 'client@example.com',
      clientName: 'Acme Corp',
      description: 'Monthly service',
      amount: 100,
      currency: 'USD',
      frequency: 'monthly',
      interval: 1,
      status: 'active',
      nextGenerationDate: nextGenDate,
      lastGeneratedAt: new Date('2026-10-17'),
      createdAt: new Date('2026-08-17'),
      updatedAt: new Date('2026-10-17'),
    }
    vi.mocked(prisma.subscription.findFirst).mockResolvedValue(mockSubscription as never)

    const res = await GET(makeRequest(), { params })
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.subscription.billingPeriod).toBeDefined()
    expect(data.subscription.billingPeriod.start).toBeDefined()
    expect(data.subscription.billingPeriod.end).toBeDefined()
  })

  it('returns 401 when no auth token provided', async () => {
    const request = new NextRequest(`http://localhost:3000/api/subscriptions/${mockSubscriptionId}`)
    const res = await GET(request, { params })
    const data = await res.json()
    expect(res.status).toBe(401)
    expect(data.error).toBe('Unauthorized')
  })

  it('returns 401 when the token is invalid', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await GET(makeRequest(), { params })
    expect(res.status).toBe(401)
  })

  it('returns 404 when the user record cannot be found', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
    const res = await GET(makeRequest(), { params })
    expect(res.status).toBe(404)
  })

  it('returns 404 when the subscription does not exist or belongs to another user', async () => {
    vi.mocked(prisma.subscription.findFirst).mockResolvedValue(null)
    const res = await GET(makeRequest(), { params })
    const data = await res.json()
    expect(res.status).toBe(404)
    expect(data.error).toBe('Subscription not found')
  })

  it('returns 404 (not 403) for non-owned subscriptions to avoid leaking existence', async () => {
    // This test ensures we return 404 rather than 403, which would leak that
    // a subscription exists but belongs to another user
    vi.mocked(prisma.subscription.findFirst).mockResolvedValue(null)
    const res = await GET(makeRequest(), { params })
    const data = await res.json()
    expect(res.status).toBe(404)
    expect(data.error).toBe('Subscription not found')
  })

  it('scopes the lookup to the authenticated user (ownership check)', async () => {
    vi.mocked(prisma.subscription.findFirst).mockResolvedValue({
      id: mockSubscriptionId,
      amount: 100,
      currency: 'USD',
      status: 'active',
      nextGenerationDate: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never)
    await GET(makeRequest(), { params })
    expect(prisma.subscription.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: mockSubscriptionId, userId: mockUserId } }),
    )
  })

  it('returns 500 on database error', async () => {
    vi.mocked(prisma.subscription.findFirst).mockRejectedValue(
      new Error('Database connection failed'),
    )
    const res = await GET(makeRequest(), { params })
    const data = await res.json()
    expect(res.status).toBe(500)
    expect(data.error).toBe('Failed to fetch subscription')
  })

  it('includes cancelled status in response', async () => {
    const mockSubscription = {
      id: mockSubscriptionId,
      userId: mockUserId,
      clientEmail: 'client@example.com',
      clientName: 'Acme Corp',
      description: 'Monthly service',
      amount: 100,
      currency: 'USD',
      frequency: 'monthly',
      interval: 1,
      status: 'cancelled',
      nextGenerationDate: new Date('2026-11-17'),
      lastGeneratedAt: new Date('2026-10-17'),
      createdAt: new Date('2026-08-17'),
      updatedAt: new Date('2026-10-20'),
    }
    vi.mocked(prisma.subscription.findFirst).mockResolvedValue(mockSubscription as never)

    const res = await GET(makeRequest(), { params })
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.subscription.status).toBe('cancelled')
  })

  it('converts Decimal amounts to numbers in response', async () => {
    const mockSubscription = {
      id: mockSubscriptionId,
      userId: mockUserId,
      clientEmail: 'client@example.com',
      clientName: 'Acme Corp',
      description: 'Monthly service',
      amount: 99.99, // Decimal from Prisma
      currency: 'USD',
      frequency: 'monthly',
      interval: 1,
      status: 'active',
      nextGenerationDate: new Date('2026-11-17'),
      lastGeneratedAt: new Date('2026-10-17'),
      createdAt: new Date('2026-08-17'),
      updatedAt: new Date('2026-10-17'),
    }
    vi.mocked(prisma.subscription.findFirst).mockResolvedValue(mockSubscription as never)

    const res = await GET(makeRequest(), { params })
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(typeof data.subscription.amount).toBe('number')
    expect(data.subscription.amount).toBe(99.99)
  })

  it('returns null for missing optional dates', async () => {
    const mockSubscription = {
      id: mockSubscriptionId,
      userId: mockUserId,
      clientEmail: 'client@example.com',
      clientName: 'Acme Corp',
      description: 'Monthly service',
      amount: 100,
      currency: 'USD',
      frequency: 'monthly',
      interval: 1,
      status: 'active',
      nextGenerationDate: null,
      lastGeneratedAt: null,
      createdAt: new Date('2026-08-17'),
      updatedAt: new Date('2026-08-17'),
    }
    vi.mocked(prisma.subscription.findFirst).mockResolvedValue(mockSubscription as never)

    const res = await GET(makeRequest(), { params })
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.subscription.nextGenerationDate).toBeNull()
    expect(data.subscription.lastGeneratedAt).toBeNull()
  })

  it('handles billing period calculation errors gracefully', async () => {
    const { billingPeriodStart } = await import('@/lib/proration')
    vi.mocked(billingPeriodStart).mockImplementation(() => {
      throw new Error('Unsupported billing frequency')
    })

    const mockSubscription = {
      id: mockSubscriptionId,
      userId: mockUserId,
      clientEmail: 'client@example.com',
      clientName: 'Acme Corp',
      description: 'Monthly service',
      amount: 100,
      currency: 'USD',
      frequency: 'unsupported',
      interval: 1,
      status: 'active',
      nextGenerationDate: new Date('2026-11-17'),
      lastGeneratedAt: new Date('2026-10-17'),
      createdAt: new Date('2026-08-17'),
      updatedAt: new Date('2026-10-17'),
    }
    vi.mocked(prisma.subscription.findFirst).mockResolvedValue(mockSubscription as never)

    const res = await GET(makeRequest(), { params })
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.subscription.billingPeriod).toBeNull()
  })
})
