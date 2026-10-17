import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { computeWebhookSignature, signaturesMatch } from '@/lib/webhook-signature'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    userWebhook: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    webhookDelivery: {
      create: vi.fn(),
    },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}))

import { POST } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const actor = { id: 'user-1', email: 'dev@lancepay.io' }
const NOW = new Date('2026-10-17T12:00:00.000Z')
const REAL_SIGNING_SECRET = 'whsec_live_real_secret_key_123456'

function makeRequest(body?: unknown): NextRequest {
  return new NextRequest('http://localhost/api/webhook-simulator/trigger', {
    method: 'POST',
    headers: { authorization: 'Bearer valid-token' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

describe('POST /api/webhook-simulator/trigger (#1570)', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)

    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue(actor as any)
    vi.mocked(prisma.userWebhook.findUnique).mockResolvedValue({
      id: 'wh-1',
      userId: 'user-1',
      targetUrl: 'https://developer.example.com/webhooks/lancepay',
      signingSecret: REAL_SIGNING_SECRET,
      isActive: true,
      status: 'ACTIVE',
      subscribedEvents: ['invoice.paid', 'payment.received'],
    } as any)

    vi.mocked(prisma.webhookDelivery.create).mockImplementation(
      (async (args: any) => ({
        id: 'del-sim-1',
        webhookId: args.data.webhookId,
        eventType: args.data.eventType,
        status: args.data.status,
        attemptCount: args.data.attemptCount,
        lastStatusCode: args.data.lastStatusCode,
        lastError: args.data.lastError,
        lastAttemptAt: args.data.lastAttemptAt,
        createdAt: NOW,
      })) as any
    )

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    } as any)
  })

  afterEach(() => {
    global.fetch = originalFetch
    vi.useRealTimers()
  })

  it('triggers a canned event signed with the real webhook signingSecret and records a synthetic delivery', async () => {
    const res = await POST(
      makeRequest({
        webhookId: 'wh-1',
        eventType: 'invoice.paid',
        overrides: { amount: '999.00' },
      })
    )

    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.delivery.isSynthetic).toBe(true)
    expect(body.delivery.status).toBe('simulated_delivered')
    expect(body.payload.isSynthetic).toBe(true)
    expect(body.payload.data.amount).toBe('999.00')

    // Verify fetch was called with identical HMAC-SHA256 signature header
    expect(global.fetch).toHaveBeenCalledTimes(1)
    const [url, fetchInit] = vi.mocked(global.fetch).mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://developer.example.com/webhooks/lancepay')
    const headers = fetchInit.headers as Record<string, string>
    const rawSentBody = fetchInit.body as string

    const expectedSig = computeWebhookSignature(rawSentBody, REAL_SIGNING_SECRET)
    expect(signaturesMatch(expectedSig, headers['X-LancePay-Signature'])).toBe(true)
    expect(headers['X-LancePay-Synthetic']).toBe('true')

    // Verify recorded delivery row is flagged as synthetic and excluded from live failure stats
    const createCall = vi.mocked(prisma.webhookDelivery.create).mock.calls[0][0] as any
    expect(createCall.data.status).toBe('simulated_delivered')
    expect(JSON.parse(createCall.data.payload).isSynthetic).toBe(true)
    expect(prisma.userWebhook.update).not.toHaveBeenCalled()
  })

  it('records simulated_failed on endpoint 500 without incrementing live consecutiveFailures', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    } as any)

    const res = await POST(
      makeRequest({
        webhookId: 'wh-1',
        eventType: 'invoice.paid',
      })
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.delivery.status).toBe('simulated_failed')
    expect(body.delivery.lastStatusCode).toBe(503)
    // Must not touch live webhook consecutiveFailures
    expect(prisma.userWebhook.update).not.toHaveBeenCalled()
  })

  it('rejects triggering an event shape the webhook does not subscribe to (422 EVENT_NOT_SUBSCRIBED)', async () => {
    const res = await POST(
      makeRequest({
        webhookId: 'wh-1',
        eventType: 'payout.completed', // wh-1 only subscribes to invoice.paid & payment.received
      })
    )

    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.code).toBe('EVENT_NOT_SUBSCRIBED')
    expect(global.fetch).not.toHaveBeenCalled()
    expect(prisma.webhookDelivery.create).not.toHaveBeenCalled()
  })

  it("returns 403 when attempting to trigger another developer's webhook and 404 when missing", async () => {
    vi.mocked(prisma.userWebhook.findUnique).mockResolvedValueOnce({
      id: 'wh-other',
      userId: 'other-user-99',
      targetUrl: 'https://other.example.com',
      signingSecret: REAL_SIGNING_SECRET,
      subscribedEvents: ['invoice.paid'],
    } as any)

    const forbidden = await POST(
      makeRequest({ webhookId: 'wh-other', eventType: 'invoice.paid' })
    )
    expect(forbidden.status).toBe(403)

    vi.mocked(prisma.userWebhook.findUnique).mockResolvedValueOnce(null)
    const notFound = await POST(
      makeRequest({ webhookId: 'wh-missing', eventType: 'invoice.paid' })
    )
    expect(notFound.status).toBe(404)
  })
})
