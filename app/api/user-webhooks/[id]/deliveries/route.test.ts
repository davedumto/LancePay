import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    userWebhook: { findUnique: vi.fn() },
    webhookDelivery: { findMany: vi.fn(), count: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUser = { id: 'user-1', role: 'freelancer', email: 'user@test.com' }
const mockClaims = { userId: 'privy-1' }
const mockWebhook = {
  id: 'wh-1',
  userId: 'user-1',
  targetUrl: 'https://merchant.example.com/webhooks',
  signingSecret: 'secret-never-exposed',
}

const sampleDeliveries = [
  {
    id: 'del-2',
    webhookId: 'wh-1',
    eventType: 'invoice.paid',
    payload: '{"event":"invoice.paid","id":"inv-2"}',
    status: 'delivered',
    attemptCount: 1,
    lastStatusCode: 200,
    lastError: null,
    lastAttemptAt: new Date('2026-09-24T12:05:00Z'),
    nextRetryAt: null,
    createdAt: new Date('2026-09-24T12:05:00Z'),
    updatedAt: new Date('2026-09-24T12:05:00Z'),
  },
  {
    id: 'del-1',
    webhookId: 'wh-1',
    eventType: 'withdrawal.failed',
    payload: '{"event":"withdrawal.failed","id":"wd-1"}',
    status: 'failed',
    attemptCount: 3,
    lastStatusCode: 503,
    lastError: 'HTTP 503',
    lastAttemptAt: new Date('2026-09-24T12:00:00Z'),
    nextRetryAt: new Date('2026-09-24T12:10:00Z'),
    createdAt: new Date('2026-09-24T11:55:00Z'),
    updatedAt: new Date('2026-09-24T12:00:00Z'),
  },
]

function makeRequest(
  query: Record<string, string> = {},
  token: string | null = 'valid-token',
): NextRequest {
  const url = new URL('http://localhost/api/user-webhooks/wh-1/deliveries')
  for (const [k, v] of Object.entries(query)) {
    url.searchParams.set(k, v)
  }
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest(url.toString(), { headers })
}

const params = { params: Promise.resolve({ id: 'wh-1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
  vi.mocked(prisma.userWebhook.findUnique).mockResolvedValue(mockWebhook as any)
  vi.mocked(prisma.webhookDelivery.findMany).mockResolvedValue(sampleDeliveries as any)
  vi.mocked(prisma.webhookDelivery.count).mockResolvedValue(2)
})

describe('GET /api/user-webhooks/[id]/deliveries', () => {
  it('returns paginated delivery history for the webhook owner', async () => {
    const res = await GET(makeRequest(), params)
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.webhookId).toBe('wh-1')
    expect(data.deliveries).toHaveLength(2)
    expect(data.deliveries[0]).toMatchObject({
      id: 'del-2',
      webhookId: 'wh-1',
      eventType: 'invoice.paid',
      status: 'delivered',
      attemptCount: 1,
      lastStatusCode: 200,
      lastError: null,
    })
    expect(data.deliveries[1]).toMatchObject({
      id: 'del-1',
      eventType: 'withdrawal.failed',
      status: 'failed',
      attemptCount: 3,
      lastStatusCode: 503,
      lastError: 'HTTP 503',
    })
    expect(data.total).toBe(2)
    expect(data.page).toBe(1)
    expect(data.limit).toBe(20)
    expect(data.pagination).toEqual({
      page: 1,
      limit: 20,
      total: 2,
      totalPages: 1,
      hasMore: false,
      nextCursor: null,
    })
    expect(JSON.stringify(data)).not.toContain('secret-never-exposed')
  })

  it('filters deliveries by status and eventType', async () => {
    vi.mocked(prisma.webhookDelivery.findMany).mockResolvedValue([sampleDeliveries[1]] as any)
    vi.mocked(prisma.webhookDelivery.count).mockResolvedValue(1)

    const res = await GET(
      makeRequest({ status: 'failed', eventType: 'withdrawal.failed', page: '2', limit: '5' }),
      params,
    )
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.deliveries).toHaveLength(1)
    expect(prisma.webhookDelivery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          webhookId: 'wh-1',
          status: 'failed',
          eventType: 'withdrawal.failed',
        },
        take: 5,
        skip: 5,
        orderBy: { createdAt: 'desc' },
      }),
    )
  })

  it('supports cursor-based pagination and sets nextCursor when more rows exist', async () => {
    vi.mocked(prisma.webhookDelivery.findMany).mockResolvedValue([sampleDeliveries[0]] as any)
    vi.mocked(prisma.webhookDelivery.count).mockResolvedValue(3)

    const res = await GET(makeRequest({ cursor: 'del-3', limit: '1' }), params)
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.hasMore).toBe(true)
    expect(data.nextCursor).toBe('del-2')
    expect(prisma.webhookDelivery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { id: 'del-3' },
        skip: 1,
        take: 1,
      }),
    )
  })

  it('returns 400 for an invalid status filter', async () => {
    const res = await GET(makeRequest({ status: 'unknown_status' }), params)
    expect(res.status).toBe(400)
    expect(prisma.webhookDelivery.findMany).not.toHaveBeenCalled()
  })

  it('returns 400 for out-of-range limit or invalid page', async () => {
    const resLimitHigh = await GET(makeRequest({ limit: '500' }), params)
    expect(resLimitHigh.status).toBe(400)

    const resLimitZero = await GET(makeRequest({ limit: '0' }), params)
    expect(resLimitZero.status).toBe(400)

    const resPageInvalid = await GET(makeRequest({ page: '0' }), params)
    expect(resPageInvalid.status).toBe(400)
  })

  it('returns 403 when caller does not own the webhook', async () => {
    vi.mocked(prisma.userWebhook.findUnique).mockResolvedValue({
      ...mockWebhook,
      userId: 'other-user',
    } as any)

    const res = await GET(makeRequest(), params)
    expect(res.status).toBe(403)
    expect(prisma.webhookDelivery.findMany).not.toHaveBeenCalled()
  })

  it('returns 404 when the webhook does not exist', async () => {
    vi.mocked(prisma.userWebhook.findUnique).mockResolvedValue(null)
    const res = await GET(makeRequest(), params)
    expect(res.status).toBe(404)
  })

  it('returns 404 when the user does not exist', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
    const res = await GET(makeRequest(), params)
    expect(res.status).toBe(404)
  })

  it('returns 401 when authorization header is missing or invalid', async () => {
    const resMissing = await GET(makeRequest({}, null), params)
    expect(resMissing.status).toBe(401)

    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const resInvalid = await GET(makeRequest(), params)
    expect(resInvalid.status).toBe(401)
  })

  it('returns 500 on unexpected database error', async () => {
    vi.mocked(prisma.webhookDelivery.findMany).mockRejectedValue(new Error('DB failure'))
    const res = await GET(makeRequest(), params)
    expect(res.status).toBe(500)
  })
})
