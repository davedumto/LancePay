import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { POST } from './route'
import { NextRequest } from 'next/server'
import crypto from 'crypto'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    userWebhook: { findFirst: vi.fn() },
    webhookDelivery: { create: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}))

// Mock global fetch
const originalFetch = global.fetch
const mockFetch = vi.fn()
global.fetch = mockFetch

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUser = { id: 'user-1', privyId: 'privy-1' }
const mockClaims = { userId: 'privy-1' }
const mockWebhook = {
  id: 'wh-123',
  userId: 'user-1',
  targetUrl: 'https://example.com/webhook',
  signingSecret: 'secret_1234567890abcdef',
  subscribedEvents: ['invoice.paid', 'payout.completed'],
  isActive: true,
}

function makeTriggerRequest(body: unknown, auth = 'Bearer valid-token'): NextRequest {
  return new NextRequest('http://localhost/api/webhook-simulator/trigger', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: auth } : {}),
    },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
  vi.mocked(prisma.userWebhook.findFirst).mockResolvedValue(mockWebhook as any)
  vi.mocked(prisma.webhookDelivery.create).mockImplementation(async ({ data }: any) => ({
    id: 'del-sim-1',
    status: data.status,
    attemptCount: data.attemptCount,
    lastAttemptAt: data.lastAttemptAt,
    lastStatusCode: data.lastStatusCode,
    createdAt: new Date(),
  }))
  mockFetch.mockResolvedValue({
    status: 200,
    ok: true,
    text: async () => 'OK',
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/webhook-simulator/trigger', () => {
  it('successfully fires a synthetic webhook signed with the real secret', async () => {
    const req = makeTriggerRequest({
      webhookId: 'wh-123',
      eventType: 'invoice.paid',
    })

    const res = await POST(req)
    expect(res.status).toBe(200)

    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.isSynthetic).toBe(true)
    expect(json.eventType).toBe('invoice.paid')

    // Verify fetch was called with real HMAC signature
    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.com/webhook',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Webhook-Event': 'invoice.paid',
          'X-Webhook-Synthetic': 'true',
        }),
      }),
    )

    // Verify signature header matches payload signed with signingSecret
    const fetchCall = mockFetch.mock.calls[0]
    const headers = fetchCall[1].headers
    const sentBody = fetchCall[1].body
    const signature = headers['X-Webhook-Signature']
    const expectedSig = crypto
      .createHmac('sha256', mockWebhook.signingSecret)
      .update(sentBody)
      .digest('hex')
    expect(signature).toBe(expectedSig)

    // Verify recorded in delivery table flagged as synthetic
    expect(prisma.webhookDelivery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        webhookId: 'wh-123',
        eventType: '[SYNTHETIC] invoice.paid',
        status: 'synthetic_delivered',
        lastStatusCode: 200,
      }),
      select: expect.any(Object),
    })
  })

  it('rejects triggering an event that the webhook does not subscribe to', async () => {
    const req = makeTriggerRequest({
      webhookId: 'wh-123',
      eventType: 'unsubscribed.event',
    })

    const res = await POST(req)
    expect(res.status).toBe(400)

    const json = await res.json()
    expect(json.code).toBe('UNSUBSCRIBED_EVENT')
    expect(json.error).toMatch(/not subscribed to event/i)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('records synthetic_failed when target endpoint returns 500 without crashing', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 500,
      ok: false,
      text: async () => 'Internal Server Error',
    })

    const req = makeTriggerRequest({
      webhookId: 'wh-123',
      eventType: 'invoice.paid',
    })

    const res = await POST(req)
    expect(res.status).toBe(502)

    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.statusCode).toBe(500)

    expect(prisma.webhookDelivery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'synthetic_failed',
        lastStatusCode: 500,
      }),
      select: expect.any(Object),
    })
  })

  it('returns 404 when webhook is not found or not owned by caller', async () => {
    vi.mocked(prisma.userWebhook.findFirst).mockResolvedValue(null)

    const req = makeTriggerRequest({
      webhookId: 'wh-unknown',
      eventType: 'invoice.paid',
    })

    const res = await POST(req)
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error).toBe('Webhook not found')
  })

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)

    const req = makeTriggerRequest({
      webhookId: 'wh-123',
      eventType: 'invoice.paid',
    })

    const res = await POST(req)
    expect(res.status).toBe(401)
  })
})
