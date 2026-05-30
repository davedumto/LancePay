import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    userWebhook: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { getIdempotentResponse, setIdempotentResponse } from '../../_lib/idempotency'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFindUnique = vi.mocked(prisma.user.findUnique)
const mockedWebhookCount = vi.mocked(prisma.userWebhook.count)
const mockedWebhookCreate = vi.mocked(prisma.userWebhook.create)

const fakeUser = { id: 'user-1', privyId: 'privy-1' }

beforeEach(() => {
  vi.resetAllMocks()
  mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
  mockedUserFindUnique.mockResolvedValue(fakeUser as never)
  // Clear idempotency store by re-importing to reset module state
  vi.resetModules()
})

describe('POST /api/routes-b/webhooks with idempotency', () => {
  it('creates a webhook on first request with idempotency-key', async () => {
    mockedWebhookCount.mockResolvedValue(0)
    mockedWebhookCreate.mockResolvedValue({
      id: 'wh-1',
      targetUrl: 'https://example.test/webhook',
      description: null,
      signingSecret: 'secret123',
      createdAt: new Date('2026-04-29T00:00:00Z'),
    } as never)

    const { POST } = await import('../route')
    const request = new NextRequest('http://localhost/api/routes-b/webhooks', {
      method: 'POST',
      headers: { 
        authorization: 'Bearer token',
        'idempotency-key': 'key-123',
      },
      body: JSON.stringify({
        targetUrl: 'https://example.test/webhook',
      }),
    })

    const res = await POST(request)
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.id).toBe('wh-1')
    expect(mockedWebhookCreate).toHaveBeenCalled()
  })

  it('returns cached response on repeat request with same key and body', async () => {
    mockedWebhookCount.mockResolvedValue(0)
    mockedWebhookCreate.mockResolvedValue({
      id: 'wh-1',
      targetUrl: 'https://example.test/webhook',
      description: null,
      signingSecret: 'secret123',
      createdAt: new Date('2026-04-29T00:00:00Z'),
    } as never)

    const { POST } = await import('../route')
    const body = { targetUrl: 'https://example.test/webhook' }

    // First request
    const request1 = new NextRequest('http://localhost/api/routes-b/webhooks', {
      method: 'POST',
      headers: { 
        authorization: 'Bearer token',
        'idempotency-key': 'key-123',
      },
      body: JSON.stringify(body),
    })
    const res1 = await POST(request1)
    expect(res1.status).toBe(201)

    // Reset mock to ensure it's not called again
    mockedWebhookCreate.mockClear()

    // Second request with same key and body
    const request2 = new NextRequest('http://localhost/api/routes-b/webhooks', {
      method: 'POST',
      headers: { 
        authorization: 'Bearer token',
        'idempotency-key': 'key-123',
      },
      body: JSON.stringify(body),
    })
    const res2 = await POST(request2)
    expect(res2.status).toBe(201)
    const json2 = await res2.json()
    expect(json2.id).toBe('wh-1')
    expect(mockedWebhookCreate).not.toHaveBeenCalled()
  })

  it('returns 409 conflict on repeat request with same key but different body', async () => {
    mockedWebhookCount.mockResolvedValue(0)
    mockedWebhookCreate.mockResolvedValue({
      id: 'wh-1',
      targetUrl: 'https://example.test/webhook',
      description: null,
      signingSecret: 'secret123',
      createdAt: new Date('2026-04-29T00:00:00Z'),
    } as never)

    const { POST } = await import('../route')

    // First request
    const request1 = new NextRequest('http://localhost/api/routes-b/webhooks', {
      method: 'POST',
      headers: { 
        authorization: 'Bearer token',
        'idempotency-key': 'key-123',
      },
      body: JSON.stringify({ targetUrl: 'https://example.test/webhook' }),
    })
    const res1 = await POST(request1)
    expect(res1.status).toBe(201)

    // Second request with same key but different body
    const request2 = new NextRequest('http://localhost/api/routes-b/webhooks', {
      method: 'POST',
      headers: { 
        authorization: 'Bearer token',
        'idempotency-key': 'key-123',
      },
      body: JSON.stringify({ targetUrl: 'https://different.test/webhook' }),
    })
    const res2 = await POST(request2)
    expect(res2.status).toBe(409)
    const json2 = await res2.json()
    expect(json2.error).toBe('Idempotency conflict')
  })

  it('works normally without idempotency-key header', async () => {
    mockedWebhookCount.mockResolvedValue(0)
    mockedWebhookCreate.mockResolvedValue({
      id: 'wh-1',
      targetUrl: 'https://example.test/webhook',
      description: null,
      signingSecret: 'secret123',
      createdAt: new Date('2026-04-29T00:00:00Z'),
    } as never)

    const { POST } = await import('../route')
    const request = new NextRequest('http://localhost/api/routes-b/webhooks', {
      method: 'POST',
      headers: { authorization: 'Bearer token' },
      body: JSON.stringify({
        targetUrl: 'https://example.test/webhook',
      }),
    })

    const res = await POST(request)
    expect(res.status).toBe(201)
    expect(mockedWebhookCreate).toHaveBeenCalled()
  })

  it('handles different idempotency keys independently', async () => {
    mockedWebhookCount.mockResolvedValue(0)
    mockedWebhookCreate.mockResolvedValue({
      id: 'wh-1',
      targetUrl: 'https://example.test/webhook',
      description: null,
      signingSecret: 'secret123',
      createdAt: new Date('2026-04-29T00:00:00Z'),
    } as never)

    const { POST } = await import('../route')
    const body = { targetUrl: 'https://example.test/webhook' }

    // First request with key-1
    const request1 = new NextRequest('http://localhost/api/routes-b/webhooks', {
      method: 'POST',
      headers: { 
        authorization: 'Bearer token',
        'idempotency-key': 'key-1',
      },
      body: JSON.stringify(body),
    })
    const res1 = await POST(request1)
    expect(res1.status).toBe(201)

    mockedWebhookCreate.mockClear()
    mockedWebhookCreate.mockResolvedValue({
      id: 'wh-2',
      targetUrl: 'https://example.test/webhook',
      description: null,
      signingSecret: 'secret456',
      createdAt: new Date('2026-04-29T00:00:00Z'),
    } as never)

    // Second request with different key-2 should create new webhook
    const request2 = new NextRequest('http://localhost/api/routes-b/webhooks', {
      method: 'POST',
      headers: { 
        authorization: 'Bearer token',
        'idempotency-key': 'key-2',
      },
      body: JSON.stringify(body),
    })
    const res2 = await POST(request2)
    expect(res2.status).toBe(201)
    expect(mockedWebhookCreate).toHaveBeenCalled()
  })
})
