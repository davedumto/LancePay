import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    userWebhook: { findMany: vi.fn(), count: vi.fn(), create: vi.fn() },
  },
}))

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn() },
}))

vi.mock('../../_lib/idempotency', () => ({
  getIdempotentResponse: vi.fn(),
  setIdempotentResponse: vi.fn(),
}))

vi.mock('../../_lib/webhook-events', () => ({
  validateEventTypes: vi.fn((types) => types),
  getDefaultEventTypes: vi.fn(() => ['invoice.created']),
}))

vi.mock('../../_lib/openapi', () => ({
  registerRoute: vi.fn(),
}))

vi.mock('../../_lib/webhook-fingerprint', () => ({
  generateSecretFingerprint: vi.fn(() => 'fp-abc123'),
}))

vi.mock('../../_lib/hmac', () => ({
  generateWebhookSecret: vi.fn(() => 'whsec_test123'),
}))

vi.mock('../../_lib/webhook-custom-headers', () => ({
  getCustomHeaders: vi.fn(() => ({})),
  setCustomHeaders: vi.fn(),
  validateCustomHeaders: vi.fn(() => ({ ok: true, headers: {} })),
}))

vi.mock('../../_lib/with-request-id', () => ({
  withRequestId: vi.fn((handler) => handler),
}))

vi.mock('../../_lib/with-body-limit', () => ({
  withBodyLimit: vi.fn((handler) => handler),
}))

vi.mock('../../_lib/with-methods', () => ({
  withMethods: vi.fn((handlers) => handlers),
}))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { getIdempotentResponse } from '../../_lib/idempotency'
import { validateCustomHeaders } from '../../_lib/webhook-custom-headers'

function makeGetRequest() {
  return new NextRequest('http://localhost/api/routes-b/webhooks', {
    headers: { authorization: 'Bearer test-token' },
  })
}

function makePostRequest(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/routes-b/webhooks', {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

describe('GET /api/routes-b/webhooks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns webhooks for authenticated user', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-123' })
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' })
    vi.mocked(prisma.userWebhook.findMany).mockResolvedValue([
      {
        id: 'wh-1',
        targetUrl: 'https://example.com/hook',
        description: 'Test webhook',
        isActive: true,
        subscribedEvents: ['invoice.created'],
        lastTriggeredAt: null,
        signingSecret: 'whsec_abc',
        createdAt: new Date(),
      },
    ])

    const { GET } = await import('../route')
    const res = await GET(makeGetRequest())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.webhooks).toHaveLength(1)
    expect(body.webhooks[0].id).toBe('wh-1')
    expect(body.webhooks[0].secretFingerprint).toBe('fp-abc123')
    expect(body.webhooks[0].signingSecret).toBeUndefined()
  })

  it('returns 401 for unauthenticated request', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)

    const { GET } = await import('../route')
    const res = await GET(makeGetRequest())
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.error).toBe('Unauthorized')
  })

  it('returns empty array when user has no webhooks', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-123' })
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' })
    vi.mocked(prisma.userWebhook.findMany).mockResolvedValue([])

    const { GET } = await import('../route')
    const res = await GET(makeGetRequest())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.webhooks).toEqual([])
  })

  it('returns 500 on internal error', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-123' })
    vi.mocked(prisma.user.findUnique).mockRejectedValue(new Error('db error'))

    const { GET } = await import('../route')
    const res = await GET(makeGetRequest())
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.error).toBe('Failed to get webhooks')
  })
})

describe('POST /api/routes-b/webhooks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates a webhook successfully', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-123' })
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' })
    vi.mocked(prisma.userWebhook.count).mockResolvedValue(0)
    vi.mocked(prisma.userWebhook.create).mockResolvedValue({
      id: 'wh-new',
      targetUrl: 'https://example.com/hook',
      description: 'My webhook',
      signingSecret: 'whsec_new',
      subscribedEvents: ['invoice.created'],
      createdAt: new Date(),
    })

    const { POST } = await import('../route')
    const res = await POST(makePostRequest({
      targetUrl: 'https://example.com/hook',
      description: 'My webhook',
    }))
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.id).toBe('wh-new')
    expect(body.signingSecret).toBe('whsec_test123')
  })

  it('returns 401 for unauthenticated request', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)

    const { POST } = await import('../route')
    const res = await POST(makePostRequest({ targetUrl: 'https://example.com/hook' }))
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.error).toBe('Unauthorized')
  })

  it('returns 400 for missing targetUrl', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-123' })
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' })

    const { POST } = await import('../route')
    const res = await POST(makePostRequest({}))
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toBe('targetUrl is required')
  })

  it('returns 400 for non-HTTPS targetUrl', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-123' })
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' })

    const { POST } = await import('../route')
    const res = await POST(makePostRequest({ targetUrl: 'http://example.com/hook' }))
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toBe('Invalid HTTPS targetUrl')
  })

  it('returns 400 for description too long', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-123' })
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' })

    const { POST } = await import('../route')
    const res = await POST(makePostRequest({
      targetUrl: 'https://example.com/hook',
      description: 'x'.repeat(101),
    }))
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toBe('Invalid description')
  })

  it('returns 429 when webhook limit reached', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-123' })
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' })
    vi.mocked(prisma.userWebhook.count).mockResolvedValue(10)

    const { POST } = await import('../route')
    const res = await POST(makePostRequest({ targetUrl: 'https://example.com/hook' }))
    const body = await res.json()

    expect(res.status).toBe(429)
    expect(body.error).toBe('Webhook limit reached')
  })

  it('returns 409 on idempotency conflict', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-123' })
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' })
    vi.mocked(getIdempotentResponse).mockReturnValue({
      bodyHash: 'different-hash',
      status: 201,
      body: { id: 'wh-old' },
    })

    const { POST } = await import('../route')
    const res = await POST(
      makePostRequest({ targetUrl: 'https://example.com/hook' }, { 'idempotency-key': 'key-123' }),
    )
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.error).toBe('Idempotency conflict')
  })

  it('returns 400 for invalid custom headers', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-123' })
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1' })
    vi.mocked(validateCustomHeaders).mockReturnValue({ ok: false, error: 'Invalid headers' })

    const { POST } = await import('../route')
    const res = await POST(makePostRequest({
      targetUrl: 'https://example.com/hook',
      headers: { bad: 'header' },
    }))
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toBe('Invalid headers')
  })
})
