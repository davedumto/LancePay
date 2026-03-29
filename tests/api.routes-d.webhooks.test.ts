import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const findUnique = vi.fn()
const webhookFindMany = vi.fn()
const webhookCount = vi.fn()
const webhookCreate = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique },
    userWebhook: { findMany: webhookFindMany, count: webhookCount, create: webhookCreate },
  },
}))

const BASE_URL = 'http://localhost/api/routes-d/webhooks'

function makeRequest(method: string, body?: unknown) {
  return new NextRequest(BASE_URL, {
    method,
    headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

describe('GET /api/routes-d/webhooks', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 for unauthenticated requests', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-d/webhooks/route')
    const res = await GET(makeRequest('GET'))
    expect(res.status).toBe(401)
  })

  it('returns webhook list without signingSecret', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    findUnique.mockResolvedValue({ id: 'user_1' })
    webhookFindMany.mockResolvedValue([
      { id: 'wh_1', targetUrl: 'https://myapp.com/wh', description: null, isActive: true, subscribedEvents: ['invoice.paid'], createdAt: new Date('2025-01-01') },
    ])
    const { GET } = await import('@/app/api/routes-d/webhooks/route')
    const res = await GET(makeRequest('GET'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.webhooks).toHaveLength(1)
    expect(json.webhooks[0]).not.toHaveProperty('signingSecret')
  })
})

describe('POST /api/routes-d/webhooks', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 for unauthenticated requests', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-d/webhooks/route')
    const res = await POST(makeRequest('POST', { targetUrl: 'https://myapp.com/wh' }))
    expect(res.status).toBe(401)
  })

  it('returns 400 when targetUrl is missing', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    findUnique.mockResolvedValue({ id: 'user_1' })
    const { POST } = await import('@/app/api/routes-d/webhooks/route')
    const res = await POST(makeRequest('POST', {}))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/targetUrl/)
  })

  it('returns 400 for non-https targetUrl', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    findUnique.mockResolvedValue({ id: 'user_1' })
    const { POST } = await import('@/app/api/routes-d/webhooks/route')
    const res = await POST(makeRequest('POST', { targetUrl: 'http://myapp.com/wh' }))
    expect(res.status).toBe(400)
  })

  it('returns 429 when user already has 10 webhooks', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    findUnique.mockResolvedValue({ id: 'user_1' })
    webhookCount.mockResolvedValue(10)
    const { POST } = await import('@/app/api/routes-d/webhooks/route')
    const res = await POST(makeRequest('POST', { targetUrl: 'https://myapp.com/wh' }))
    expect(res.status).toBe(429)
  })

  it('returns 201 with signingSecret on success', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    findUnique.mockResolvedValue({ id: 'user_1' })
    webhookCount.mockResolvedValue(0)
    webhookCreate.mockResolvedValue({
      id: 'wh_new',
      targetUrl: 'https://myapp.com/wh',
      description: 'Production webhook',
      createdAt: new Date('2025-01-01'),
    })
    const { POST } = await import('@/app/api/routes-d/webhooks/route')
    const res = await POST(makeRequest('POST', { targetUrl: 'https://myapp.com/wh', description: 'Production webhook' }))
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json).toHaveProperty('id', 'wh_new')
    expect(json).toHaveProperty('signingSecret')
    expect(typeof json.signingSecret).toBe('string')
    expect(json.signingSecret).toHaveLength(64)
  })

  it('signingSecret is a 64-char hex string', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    findUnique.mockResolvedValue({ id: 'user_1' })
    webhookCount.mockResolvedValue(3)
    webhookCreate.mockResolvedValue({
      id: 'wh_2',
      targetUrl: 'https://myapp.com/wh2',
      description: null,
      createdAt: new Date(),
    })
    const { POST } = await import('@/app/api/routes-d/webhooks/route')
    const res = await POST(makeRequest('POST', { targetUrl: 'https://myapp.com/wh2' }))
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.signingSecret).toMatch(/^[0-9a-f]{64}$/)
  })
})
