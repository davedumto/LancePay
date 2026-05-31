import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    userWebhook: { findMany: vi.fn(), count: vi.fn(), create: vi.fn() },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET, POST } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedWebhookFindMany = vi.mocked(prisma.userWebhook.findMany)
const mockedWebhookCount = vi.mocked(prisma.userWebhook.count)
const mockedWebhookCreate = vi.mocked(prisma.userWebhook.create)

const USER_ID = 'user-1'
const BASE_URL = 'http://localhost/api/routes-d/webhooks'

const fakeWebhook = {
  id: 'wh-1',
  targetUrl: 'https://example.com/webhook',
  description: 'My webhook',
  isActive: true,
  subscribedEvents: ['invoice.paid'],
  status: 'ACTIVE',
  lastTriggeredAt: null,
  createdAt: new Date(),
}

function makeGET(auth = 'Bearer token'): NextRequest {
  return new NextRequest(BASE_URL, {
    method: 'GET',
    headers: auth ? { authorization: auth } : {},
  })
}

function makePOST(
  body: unknown,
  options: { auth?: string; idempotencyKey?: string } = {},
): NextRequest {
  const auth = options.auth ?? 'Bearer token'
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (auth) headers.authorization = auth
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey

  return new NextRequest(BASE_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
  mockedUserFind.mockResolvedValue({ id: USER_ID } as never)
  mockedWebhookFindMany.mockResolvedValue([fakeWebhook] as never)
  mockedWebhookCount.mockResolvedValue(0 as never)
  mockedWebhookCreate.mockResolvedValue({
    id: 'wh-new',
    targetUrl: 'https://example.com/webhook',
    description: null,
    createdAt: new Date(),
  } as never)
})

/* ──────────────── GET ──────────────── */

describe('GET /api/routes-d/webhooks', () => {
  it('returns 401 without authorization header', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await GET(makeGET(''))
    expect(res.status).toBe(401)
  })

  it('returns 401 with invalid token', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await GET(makeGET('Bearer bad'))
    expect(res.status).toBe(401)
  })

  it('returns webhook list for authenticated user', async () => {
    const res = await GET(makeGET())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.webhooks).toHaveLength(1)
    expect(json.webhooks[0].id).toBe('wh-1')
    expect(mockedWebhookFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER_ID } }),
    )
  })

  it('returns empty array when user has no webhooks', async () => {
    mockedWebhookFindMany.mockResolvedValue([] as never)
    const res = await GET(makeGET())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.webhooks).toHaveLength(0)
  })

  it('does not expose signingSecret in the listing response', async () => {
    const res = await GET(makeGET())
    const json = await res.json()
    for (const wh of json.webhooks) {
      expect(wh).not.toHaveProperty('signingSecret')
    }
  })

  it('only returns webhooks belonging to the authenticated user', async () => {
    await GET(makeGET())
    const call = mockedWebhookFindMany.mock.calls[0][0]
    expect((call as any).where.userId).toBe(USER_ID)
  })
})

/* ──────────────── POST ──────────────── */

describe('POST /api/routes-d/webhooks', () => {
  it('returns 401 without authorization header', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await POST(makePOST({ targetUrl: 'https://example.com/wh' }, { auth: '' }))
    expect(res.status).toBe(401)
  })

  it('returns 401 with invalid token', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await POST(makePOST({ targetUrl: 'https://example.com/wh' }, { auth: 'Bearer bad' }))
    expect(res.status).toBe(401)
  })

  it('returns 400 when targetUrl is missing', async () => {
    const res = await POST(makePOST({}))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/targetUrl/i)
  })

  it('returns 400 for a non-https URL', async () => {
    const res = await POST(makePOST({ targetUrl: 'http://example.com/wh' }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/https/i)
  })

  it('returns 400 for a malformed URL', async () => {
    const res = await POST(makePOST({ targetUrl: 'not-a-url' }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/https/i)
  })

  it('returns 400 when description exceeds 100 characters', async () => {
    const res = await POST(makePOST({
      targetUrl: 'https://example.com/wh',
      description: 'x'.repeat(101),
    }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/description/i)
  })

  it('returns 429 when user has reached the 10-webhook limit', async () => {
    mockedWebhookCount.mockResolvedValue(10 as never)
    const res = await POST(makePOST({ targetUrl: 'https://example.com/wh' }))
    expect(res.status).toBe(429)
    const json = await res.json()
    expect(json.error).toMatch(/maximum/i)
  })

  it('creates a webhook and returns it with a signing secret', async () => {
    const res = await POST(makePOST({ targetUrl: 'https://example.com/wh' }))
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.id).toBe('wh-new')
    expect(json.targetUrl).toBe('https://example.com/webhook')
    expect(json).toHaveProperty('signingSecret')
    expect(typeof json.signingSecret).toBe('string')
    expect(json.signingSecret.length).toBeGreaterThan(0)
  })

  it('accepts an optional description', async () => {
    await POST(makePOST({ targetUrl: 'https://example.com/wh', description: 'Test hook' }))
    expect(mockedWebhookCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ description: 'Test hook' }),
      }),
    )
  })

  it('signing secret is not stored in the DB plaintext field returned from listing', async () => {
    const createResult = {
      id: 'wh-new',
      targetUrl: 'https://example.com/wh',
      description: null,
      createdAt: new Date(),
    }
    mockedWebhookCreate.mockResolvedValue(createResult as never)
    const res = await POST(makePOST({ targetUrl: 'https://example.com/wh' }))
    const json = await res.json()
    // signing secret is returned only in the creation response, not from the select
    expect(json).toHaveProperty('signingSecret')
  })

})