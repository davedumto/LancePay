import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  verifyAuthToken: vi.fn(),
  userFindUnique: vi.fn(),
  subscriptionFindFirst: vi.fn(),
  loggerError: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: mocks.verifyAuthToken,
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    subscription: { findFirst: mocks.subscriptionFindFirst },
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: mocks.loggerError },
}))

import { GET } from '@/app/api/routes-d/billing/plan/route'

const BASE_URL = 'http://localhost/api/routes-d/billing/plan'

function makeRequest(token: string | null = 'valid-token') {
  const headers = new Headers()
  if (token) {
    headers.set('authorization', `Bearer ${token}`)
  }
  return new NextRequest(BASE_URL, { method: 'GET', headers })
}

describe('GET /api/routes-d/billing/plan', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when the auth token is invalid', async () => {
    mocks.verifyAuthToken.mockResolvedValue(null)
    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
  })

  it('returns plan null when the user has no active subscription', async () => {
    mocks.verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    mocks.userFindUnique.mockResolvedValue({ id: 'user_1' })
    mocks.subscriptionFindFirst.mockResolvedValue(null)

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ plan: null })
  })

  it('returns the active subscription plan summary', async () => {
    mocks.verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    mocks.userFindUnique.mockResolvedValue({ id: 'user_1' })
    mocks.subscriptionFindFirst.mockResolvedValue({
      id: 'sub_1',
      status: 'active',
      frequency: 'monthly',
      interval: 1,
      amount: '49.99',
      currency: 'USD',
      clientEmail: 'client@example.com',
      clientName: 'Client Name',
      description: 'Monthly retainer',
      nextGenerationDate: new Date('2026-07-01T00:00:00.000Z'),
      lastGeneratedAt: null,
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
      updatedAt: new Date('2026-06-02T00:00:00.000Z'),
    })

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      plan: {
        id: 'sub_1',
        status: 'active',
        frequency: 'monthly',
        interval: 1,
        amount: 49.99,
        currency: 'USD',
        clientEmail: 'client@example.com',
        clientName: 'Client Name',
        description: 'Monthly retainer',
        nextGenerationDate: new Date('2026-07-01T00:00:00.000Z').toISOString(),
        lastGeneratedAt: null,
        createdAt: new Date('2026-06-01T00:00:00.000Z').toISOString(),
        updatedAt: new Date('2026-06-02T00:00:00.000Z').toISOString(),
      },
    })
  })

  it('returns 500 when the plan query fails', async () => {
    mocks.verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    mocks.userFindUnique.mockResolvedValue({ id: 'user_1' })
    mocks.subscriptionFindFirst.mockRejectedValue(new Error('db unavailable'))

    const res = await GET(makeRequest())
    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({ error: 'Failed to get billing plan' })
    expect(mocks.loggerError).toHaveBeenCalled()
  })
})
