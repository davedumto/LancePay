import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { POST } from './route'
import { NextRequest } from 'next/server'
import { computeWebhookSignature } from '@/lib/webhook-signature'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    userWebhook: { findUnique: vi.fn(), update: vi.fn() },
    webhookDelivery: { create: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUser = { id: 'user-1', role: 'freelancer', email: 'user@test.com' }
const mockClaims = { userId: 'privy-1' }
const SECRET = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'
const mockWebhook = {
  id: 'wh-1',
  userId: 'user-1',
  targetUrl: 'https://merchant.example.com/webhooks/lancepay',
  signingSecret: SECRET,
  isActive: true,
  status: 'ACTIVE',
  consecutiveFailures: 2,
}

function makeRequest(token: string | null = 'valid-token'): NextRequest {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest('http://localhost/api/user-webhooks/wh-1/test', {
    method: 'POST',
    headers,
  })
}

const params = { params: Promise.resolve({ id: 'wh-1' }) }

describe('POST /api/user-webhooks/[id]/test', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
    vi.mocked(prisma.userWebhook.findUnique).mockResolvedValue(mockWebhook as any)
    vi.mocked(prisma.webhookDelivery.create).mockImplementation(async (args: any) => ({
      id: 'del-test-1',
      ...args.data,
    }))
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('sends a signed test.ping event, records a delivery row, and returns status + latency', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }))
    global.fetch = fetchMock as any

    const res = await POST(makeRequest(), params)
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.deliveryId).toBe('del-test-1')
    expect(data.webhookId).toBe('wh-1')
    expect(data.eventType).toBe('test.ping')
    expect(data.delivered).toBe(true)
    expect(data.statusCode).toBe(200)
    expect(typeof data.latencyMs).toBe('number')
    expect(data.latencyMs).toBeGreaterThanOrEqual(0)
    expect(data.error).toBeNull()

    // Verify outbound HTTP request headers & HMAC-SHA256 signature
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [calledUrl, calledInit] = fetchMock.mock.calls[0]
    expect(calledUrl).toBe(mockWebhook.targetUrl)
    expect(calledInit.method).toBe('POST')
    const expectedSig = computeWebhookSignature(calledInit.body, SECRET)
    expect(calledInit.headers['X-LancePay-Signature']).toBe(expectedSig)
    expect(calledInit.headers['X-Webhook-Signature']).toBe(expectedSig)
    expect(calledInit.headers['X-Webhook-Event']).toBe('test.ping')
    expect(data.signature).toBe(expectedSig)

    const parsedBody = JSON.parse(calledInit.body)
    expect(parsedBody.event).toBe('test.ping')
    expect(parsedBody.webhookId).toBe('wh-1')

    // Verify WebhookDelivery row created and real failure stats are not modified
    expect(prisma.webhookDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          webhookId: 'wh-1',
          eventType: 'test.ping',
          status: 'delivered',
          attemptCount: 1,
          lastStatusCode: 200,
          lastError: null,
        }),
      }),
    )
    expect(prisma.userWebhook.update).not.toHaveBeenCalled()
    expect(JSON.stringify(data)).not.toContain(SECRET)
  })

  it('records a failed test.ping delivery without incrementing consecutiveFailures on HTTP 502', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('Bad Gateway', { status: 502 })) as any

    const res = await POST(makeRequest(), params)
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.delivered).toBe(false)
    expect(data.statusCode).toBe(502)
    expect(data.error).toBe('HTTP 502')
    expect(prisma.webhookDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          webhookId: 'wh-1',
          eventType: 'test.ping',
          status: 'failed',
          lastStatusCode: 502,
          lastError: 'HTTP 502',
        }),
      }),
    )
    expect(prisma.userWebhook.update).not.toHaveBeenCalled()
  })

  it('captures network errors gracefully without throwing 500', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any

    const res = await POST(makeRequest(), params)
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.delivered).toBe(false)
    expect(data.statusCode).toBeNull()
    expect(data.error).toBe('ECONNREFUSED')
    expect(prisma.webhookDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'failed',
          lastStatusCode: null,
          lastError: 'ECONNREFUSED',
        }),
      }),
    )
    expect(prisma.userWebhook.update).not.toHaveBeenCalled()
  })

  it('forbids testing a webhook owned by another user (403)', async () => {
    vi.mocked(prisma.userWebhook.findUnique).mockResolvedValue({
      ...mockWebhook,
      userId: 'other-user',
    } as any)

    const res = await POST(makeRequest(), params)
    expect(res.status).toBe(403)
    expect(prisma.webhookDelivery.create).not.toHaveBeenCalled()
  })

  it('returns 404 when the webhook does not exist', async () => {
    vi.mocked(prisma.userWebhook.findUnique).mockResolvedValue(null)
    const res = await POST(makeRequest(), params)
    expect(res.status).toBe(404)
  })

  it('returns 404 when the user is not found', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
    const res = await POST(makeRequest(), params)
    expect(res.status).toBe(404)
  })

  it('returns 401 when authorization header is missing', async () => {
    const res = await POST(makeRequest(null), params)
    expect(res.status).toBe(401)
  })

  it('returns 401 when token is invalid', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await POST(makeRequest(), params)
    expect(res.status).toBe(401)
  })

  it('returns 500 on unexpected database failure', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 })) as any
    vi.mocked(prisma.webhookDelivery.create).mockRejectedValue(new Error('DB write failed'))

    const res = await POST(makeRequest(), params)
    expect(res.status).toBe(500)
  })
})
