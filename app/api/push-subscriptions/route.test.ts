import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    pushSubscription: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

import { GET, POST } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUser = { id: 'user-1' }
const mockClaims = { userId: 'privy-1' }
const validPayload = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
  keys: { p256dh: 'p256dh-key-value', auth: 'auth-key-value' },
  userAgent: 'Mozilla/5.0',
}
const mockSubscription = {
  id: 'sub-1',
  endpoint: validPayload.endpoint,
  userAgent: validPayload.userAgent,
  createdAt: new Date('2026-10-17T12:00:00.000Z'),
  updatedAt: new Date('2026-10-17T12:00:00.000Z'),
}

function makePost(body: unknown, token: string | null = 'token') {
  return new NextRequest('http://localhost/api/push-subscriptions', {
    method: 'POST',
    headers: token
      ? { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function makeGet(token: string | null = 'token') {
  return new NextRequest('http://localhost/api/push-subscriptions', {
    method: 'GET',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

describe('GET & POST /api/push-subscriptions (#1675)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as never)
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as never)
    vi.mocked((prisma as any).pushSubscription.findUnique).mockResolvedValue(null)
    vi.mocked((prisma as any).pushSubscription.findMany).mockResolvedValue([mockSubscription])
    vi.mocked((prisma as any).pushSubscription.upsert).mockResolvedValue(mockSubscription as never)
  })

  it('POST upserts on endpoint so re-registering the same browser does not create duplicates', async () => {
    const res1 = await POST(makePost(validPayload))
    expect(res1.status).toBe(200)
    const data1 = await res1.json()
    expect(data1.subscription.endpoint).toBe(validPayload.endpoint)

    // Simulate second registration of the same browser endpoint for the same user
    vi.mocked((prisma as any).pushSubscription.findUnique).mockResolvedValueOnce({
      id: 'sub-1',
      userId: 'user-1',
    })
    const res2 = await POST(makePost(validPayload))
    expect(res2.status).toBe(200)
    expect((prisma as any).pushSubscription.upsert).toHaveBeenCalledTimes(2)
    expect((prisma as any).pushSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { endpoint: validPayload.endpoint },
      }),
    )
  })

  it('POST returns 409 when the endpoint is already registered to a different user', async () => {
    vi.mocked((prisma as any).pushSubscription.findUnique).mockResolvedValueOnce({
      id: 'sub-other',
      userId: 'other-user-99',
    })
    const res = await POST(makePost(validPayload))
    expect(res.status).toBe(409)
    expect((prisma as any).pushSubscription.upsert).not.toHaveBeenCalled()
  })

  it('POST validates Web Push API payload structure (endpoint, keys.p256dh, keys.auth)', async () => {
    expect((await POST(makePost({ keys: validPayload.keys }))).status).toBe(400)
    expect((await POST(makePost({ ...validPayload, endpoint: 'not-a-url' }))).status).toBe(400)
    expect((await POST(makePost({ endpoint: validPayload.endpoint }))).status).toBe(400)
    expect(
      (await POST(makePost({ endpoint: validPayload.endpoint, keys: { auth: 'abc' } }))).status,
    ).toBe(400)
    expect(
      (await POST(makePost({ endpoint: validPayload.endpoint, keys: { p256dh: 'abc' } }))).status,
    ).toBe(400)
  })

  it('GET lists push subscriptions scoped strictly to the authenticated user', async () => {
    const res = await GET(makeGet())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.subscriptions).toHaveLength(1)
    expect(body.subscriptions[0].endpoint).toBe(validPayload.endpoint)
    expect((prisma as any).pushSubscription.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      orderBy: { createdAt: 'desc' },
      select: expect.any(Object),
    })
  })

  it('returns 401 when unauthenticated on both GET and POST', async () => {
    expect((await GET(makeGet(null))).status).toBe(401)
    expect((await POST(makePost(validPayload, null))).status).toBe(401)
  })
})
