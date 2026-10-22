import { describe, it, expect, beforeEach, vi } from 'vitest'
import { POST } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    subscription: { findFirst: vi.fn(), update: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUserId = 'user-123'
const mockPrivyId = 'privy-123'
const mockSubscriptionId = 'sub-123'
const params = { id: mockSubscriptionId }

function makeRequest(body?: any) {
  return new NextRequest(`http://localhost:3000/api/subscriptions/${mockSubscriptionId}/cancel`, {
    method: 'POST',
    headers: { Authorization: 'Bearer valid-token' },
    body: body ? JSON.stringify(body) : undefined,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: mockPrivyId } as never)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: mockUserId } as never)
})

describe('POST /api/subscriptions/[id]/cancel', () => {
  it('returns 401 when no auth token provided', async () => {
    const request = new NextRequest(
      `http://localhost:3000/api/subscriptions/${mockSubscriptionId}/cancel`,
      { method: 'POST' },
    )
    const res = await POST(request, { params })
    const data = await res.json()
    expect(res.status).toBe(401)
    expect(data.error).toBe('Unauthorized')
  })

  it('returns 401 when the token is invalid', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await POST(makeRequest(), { params })
    expect(res.status).toBe(401)
  })

  it('returns 404 when the user record cannot be found', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
    const res = await POST(makeRequest(), { params })
    expect(res.status).toBe(404)
  })

  it('returns 404 when the subscription does not exist or belongs to another user', async () => {
    vi.mocked(prisma.subscription.findFirst).mockResolvedValue(null)
    const res = await POST(makeRequest(), { params })
    const data = await res.json()
    expect(res.status).toBe(404)
    expect(data.error).toBe('Subscription not found')
  })

  it('cancels subscription immediately by default', async () => {
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
      nextGenerationDate: new Date('2026-11-17'),
      lastGeneratedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    const cancelledSubscription = {
      ...mockSubscription,
      status: 'cancelled',
      nextGenerationDate: new Date(0),
      updatedAt: new Date(),
    }

    vi.mocked(prisma.subscription.findFirst).mockResolvedValue(mockSubscription as never)
    vi.mocked(prisma.subscription.update).mockResolvedValue(cancelledSubscription as never)

    const res = await POST(makeRequest(), { params })
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.subscription.status).toBe('cancelled')
    expect(prisma.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: mockSubscriptionId },
        data: expect.objectContaining({ status: 'cancelled', nextGenerationDate: new Date(0) }),
      }),
    )
  })

  it('cancels subscription at period end when specified', async () => {
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
      nextGenerationDate: new Date('2026-11-17'),
      lastGeneratedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    const cancelledSubscription = {
      ...mockSubscription,
      status: 'cancelled',
      updatedAt: new Date(),
    }

    vi.mocked(prisma.subscription.findFirst).mockResolvedValue(mockSubscription as never)
    vi.mocked(prisma.subscription.update).mockResolvedValue(cancelledSubscription as never)

    const res = await POST(makeRequest({ cancelAtPeriodEnd: true }), { params })
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.subscription.status).toBe('cancelled')
    expect(prisma.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: mockSubscriptionId },
        data: expect.objectContaining({ status: 'cancelled' }),
      }),
    )
  })

  it('rejects cancelling a subscription that is already cancelled', async () => {
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
      nextGenerationDate: new Date(0),
      lastGeneratedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    vi.mocked(prisma.subscription.findFirst).mockResolvedValue(mockSubscription as never)

    const res = await POST(makeRequest(), { params })
    const data = await res.json()

    expect(res.status).toBe(409)
    expect(data.error).toBe('Subscription is already cancelled')
    expect(data.subscription.status).toBe('cancelled')
    expect(prisma.subscription.update).not.toHaveBeenCalled()
  })

  it('scopes the lookup to the authenticated user (ownership check)', async () => {
    const mockSubscription = {
      id: mockSubscriptionId,
      status: 'active',
    }
    vi.mocked(prisma.subscription.findFirst).mockResolvedValue(mockSubscription as never)
    vi.mocked(prisma.subscription.update).mockResolvedValue(mockSubscription as never)

    await POST(makeRequest(), { params })

    expect(prisma.subscription.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: mockSubscriptionId, userId: mockUserId } }),
    )
  })

  it('returns 500 on database error', async () => {
    vi.mocked(prisma.subscription.findFirst).mockRejectedValue(
      new Error('Database connection failed'),
    )
    const res = await POST(makeRequest(), { params })
    const data = await res.json()
    expect(res.status).toBe(500)
    expect(data.error).toBe('Failed to cancel subscription')
  })

  it('handles request with no JSON body gracefully', async () => {
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
      nextGenerationDate: new Date('2026-11-17'),
      lastGeneratedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    const cancelledSubscription = {
      ...mockSubscription,
      status: 'cancelled',
      nextGenerationDate: new Date(0),
      updatedAt: new Date(),
    }

    vi.mocked(prisma.subscription.findFirst).mockResolvedValue(mockSubscription as never)
    vi.mocked(prisma.subscription.update).mockResolvedValue(cancelledSubscription as never)

    const request = new NextRequest(
      `http://localhost:3000/api/subscriptions/${mockSubscriptionId}/cancel`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-token' },
      },
    )

    const res = await POST(request, { params })
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.subscription.status).toBe('cancelled')
  })

  it('prevents future invoice generation when cancelling immediately', async () => {
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
      nextGenerationDate: new Date('2026-11-17'),
      lastGeneratedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    const cancelledSubscription = {
      ...mockSubscription,
      status: 'cancelled',
      nextGenerationDate: new Date(0),
      updatedAt: new Date(),
    }

    vi.mocked(prisma.subscription.findFirst).mockResolvedValue(mockSubscription as never)
    vi.mocked(prisma.subscription.update).mockResolvedValue(cancelledSubscription as never)

    await POST(makeRequest({ cancelAtPeriodEnd: false }), { params })

    const updateCall = vi.mocked(prisma.subscription.update).mock.calls[0][0]
    // Verify nextGenerationDate is set to epoch (past date)
    expect((updateCall.data as any).nextGenerationDate).toEqual(new Date(0))
  })
})
