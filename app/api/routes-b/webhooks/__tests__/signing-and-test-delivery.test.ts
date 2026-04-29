import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { resetRateLimitBuckets } from '@/app/api/routes-b/_lib/rate-limit'
import { signWebhookPayload } from '@/app/api/routes-b/_lib/hmac'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const webhookFindUnique = vi.fn()
const webhookDeliveryCreate = vi.fn()
const webhookUpdate = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    userWebhook: { findUnique: webhookFindUnique, update: webhookUpdate },
    webhookDelivery: { create: webhookDeliveryCreate },
  },
}))

describe('routes-b webhook HMAC helper', () => {
  it('matches reference signing vector', () => {
    const signature = signWebhookPayload(
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      '1714300800',
      '{"id":"evt_1","type":"invoice.paid"}',
    )
    expect(signature).toBe('ff46e2e788f75911d270c3a9f2f03d4f1533f4625ee74de03f570fcfbea8afc2')
  })

  it('detects body tampering via signature mismatch', () => {
    const secret = 'a'.repeat(64)
    const timestamp = '1714300800'
    const signature = signWebhookPayload(secret, timestamp, '{"amount":100}')
    const tampered = signWebhookPayload(secret, timestamp, '{"amount":101}')
    expect(tampered).not.toBe(signature)
  })
})

describe('POST /api/routes-b/webhooks/[id]/test', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    resetRateLimitBuckets()
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    webhookFindUnique.mockResolvedValue({
      id: 'wh_1',
      userId: 'user_1',
      targetUrl: 'https://example.test/webhook',
      signingSecret: 'b'.repeat(64),
      isActive: true,
    })
    webhookDeliveryCreate.mockResolvedValue({})
    webhookUpdate.mockResolvedValue({})
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
      }),
    )
  })

  it('returns synchronous successful outcome', async () => {
    const { POST } = await import('@/app/api/routes-b/webhooks/[id]/test/route')
    const request = new NextRequest('http://localhost/api/routes-b/webhooks/wh_1/test', {
      method: 'POST',
      headers: { authorization: 'Bearer token' },
    })

    const response = await POST(request, { params: Promise.resolve({ id: 'wh_1' }) })
    const json = await response.json()

    expect(response.status).toBe(200)
    expect(json.outcome.ok).toBe(true)
    expect(json.outcome.status).toBe(200)
    expect(webhookDeliveryCreate).toHaveBeenCalledOnce()
  })

  it('surfaces upstream 4xx to caller', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      }),
    )
    const { POST } = await import('@/app/api/routes-b/webhooks/[id]/test/route')
    const request = new NextRequest('http://localhost/api/routes-b/webhooks/wh_1/test', {
      method: 'POST',
      headers: { authorization: 'Bearer token' },
    })
    const response = await POST(request, { params: Promise.resolve({ id: 'wh_1' }) })
    const json = await response.json()

    expect(response.status).toBe(200)
    expect(json.outcome.ok).toBe(false)
    expect(json.outcome.status).toBe(404)
    expect(json.outcome.errorMessage).toMatch(/404/)
  })

  it('surfaces timeout or network failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('The operation was aborted due to timeout')),
    )
    const { POST } = await import('@/app/api/routes-b/webhooks/[id]/test/route')
    const request = new NextRequest('http://localhost/api/routes-b/webhooks/wh_1/test', {
      method: 'POST',
      headers: { authorization: 'Bearer token' },
    })
    const response = await POST(request, { params: Promise.resolve({ id: 'wh_1' }) })
    const json = await response.json()

    expect(response.status).toBe(200)
    expect(json.outcome.ok).toBe(false)
    expect(json.outcome.errorMessage).toMatch(/timeout|aborted/i)
  })

  it('enforces per-webhook test-delivery rate limit', async () => {
    const { POST } = await import('@/app/api/routes-b/webhooks/[id]/test/route')

    for (let i = 0; i < 10; i += 1) {
      const request = new NextRequest(`http://localhost/api/routes-b/webhooks/wh_1/test?i=${i}`, {
        method: 'POST',
        headers: { authorization: 'Bearer token' },
      })
      const response = await POST(request, { params: Promise.resolve({ id: 'wh_1' }) })
      expect(response.status).toBe(200)
    }

    const blockedRequest = new NextRequest('http://localhost/api/routes-b/webhooks/wh_1/test', {
      method: 'POST',
      headers: { authorization: 'Bearer token' },
    })
    const blockedResponse = await POST(blockedRequest, { params: Promise.resolve({ id: 'wh_1' }) })
    expect(blockedResponse.status).toBe(429)
  })
})

