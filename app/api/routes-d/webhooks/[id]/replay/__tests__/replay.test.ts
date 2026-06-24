import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    webhookDelivery: { findUnique: vi.fn(), create: vi.fn() },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { POST } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const userDelegate = prisma.user as unknown as { findUnique: ReturnType<typeof vi.fn> }
const deliveryDelegate = prisma.webhookDelivery as unknown as {
  findUnique: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
}

const BASE_URL = 'http://localhost/api/routes-d/webhooks/del-1/replay'

function makePost(auth: string | null = 'Bearer tok') {
  return new NextRequest(BASE_URL, {
    method: 'POST',
    headers: auth ? { authorization: auth } : {},
  })
}

function makeCtx(id = 'del-1') {
  return { params: Promise.resolve({ id }) }
}

const deliveredDelivery = {
  id: 'del-1',
  status: 'delivered',
  eventType: 'invoice.paid',
  payload: '{"id":"evt-1"}',
  lastAttemptAt: new Date(Date.now() - 60_000).toISOString(),
  webhook: { id: 'wh-1', userId: 'u1', targetUrl: 'https://example.com/hook', isActive: true },
}

const replayedRow = {
  id: 'del-2',
  webhookId: 'wh-1',
  eventType: 'invoice.paid',
  status: 'pending',
  attemptCount: 0,
  nextRetryAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
}

describe('POST /api/routes-d/webhooks/[id]/replay', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-06-24T12:00:00Z').getTime())
  })

  it('returns 401 when unauthenticated', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await POST(makePost(null), makeCtx())
    expect(res.status).toBe(401)
  })

  it('returns 404 for unknown delivery', async () => {
    mockedVerify.mockResolvedValue({ userId: 'p1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'u1' })
    deliveryDelegate.findUnique.mockResolvedValue(null)
    const res = await POST(makePost(), makeCtx())
    expect(res.status).toBe(404)
  })

  it('returns 404 when delivery belongs to another user (ownership check)', async () => {
    mockedVerify.mockResolvedValue({ userId: 'p1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'other-user' })
    deliveryDelegate.findUnique.mockResolvedValue({
      ...deliveredDelivery,
      webhook: { ...deliveredDelivery.webhook, userId: 'u1' },
    })
    const res = await POST(makePost(), makeCtx())
    expect(res.status).toBe(404)
  })

  it('returns 409 when delivery is still pending', async () => {
    mockedVerify.mockResolvedValue({ userId: 'p1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'u1' })
    deliveryDelegate.findUnique.mockResolvedValue({ ...deliveredDelivery, status: 'pending' })
    const res = await POST(makePost(), makeCtx())
    expect(res.status).toBe(409)
  })

  it('returns 429 when replayed too soon after last attempt', async () => {
    mockedVerify.mockResolvedValue({ userId: 'p1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'u1' })
    deliveryDelegate.findUnique.mockResolvedValue({
      ...deliveredDelivery,
      lastAttemptAt: new Date(Date.now() - 5_000).toISOString(), // 5s ago, < 30s
    })
    const res = await POST(makePost(), makeCtx())
    expect(res.status).toBe(429)
  })

  it('creates a new pending delivery and returns 201', async () => {
    mockedVerify.mockResolvedValue({ userId: 'p1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'u1' })
    deliveryDelegate.findUnique.mockResolvedValue(deliveredDelivery)
    deliveryDelegate.create.mockResolvedValue(replayedRow)

    const res = await POST(makePost(), makeCtx())
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.message).toMatch(/replay/i)
    expect(body.delivery.status).toBe('pending')
  })

  it('creates delivery with copied eventType and payload', async () => {
    mockedVerify.mockResolvedValue({ userId: 'p1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'u1' })
    deliveryDelegate.findUnique.mockResolvedValue(deliveredDelivery)
    deliveryDelegate.create.mockResolvedValue(replayedRow)

    await POST(makePost(), makeCtx())

    expect(deliveryDelegate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'invoice.paid',
          payload: '{"id":"evt-1"}',
          status: 'pending',
          attemptCount: 0,
        }),
      }),
    )
  })

  it('can replay a failed delivery', async () => {
    mockedVerify.mockResolvedValue({ userId: 'p1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'u1' })
    deliveryDelegate.findUnique.mockResolvedValue({ ...deliveredDelivery, status: 'failed' })
    deliveryDelegate.create.mockResolvedValue(replayedRow)

    const res = await POST(makePost(), makeCtx())
    expect(res.status).toBe(201)
  })

  it('can replay a dead-lettered delivery', async () => {
    mockedVerify.mockResolvedValue({ userId: 'p1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'u1' })
    deliveryDelegate.findUnique.mockResolvedValue({ ...deliveredDelivery, status: 'dead_lettered' })
    deliveryDelegate.create.mockResolvedValue(replayedRow)

    const res = await POST(makePost(), makeCtx())
    expect(res.status).toBe(201)
  })
})
