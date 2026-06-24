import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const webhookFindUnique = vi.fn()
const webhookUpdate = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    userWebhook: { findUnique: webhookFindUnique, update: webhookUpdate },
  },
}))

const BASE_URL = 'http://localhost/api/routes-d/webhooks'

function makeRequest(method: string, id: string, token: string | null = 'valid-token') {
  const headers = new Headers()
  if (token) {
    headers.set('authorization', `Bearer ${token}`)
  }
  return new NextRequest(`${BASE_URL}/${id}/rotate-secret`, {
    method,
    headers,
  })
}

describe('POST /api/routes-d/webhooks/[id]/rotate-secret', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 if no authorization header is provided', async () => {
    const { POST } = await import('@/app/api/routes-d/webhooks/[id]/rotate-secret/route')
    const res = await POST(makeRequest('POST', 'wh_123', null), { params: Promise.resolve({ id: 'wh_123' }) })
    expect(res.status).toBe(401)
  })

  it('returns 404 if webhook does not exist', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
    userFindUnique.mockResolvedValue({ id: 'user-1' })
    webhookFindUnique.mockResolvedValue(null)

    const { POST } = await import('@/app/api/routes-d/webhooks/[id]/rotate-secret/route')
    const res = await POST(makeRequest('POST', 'wh_123'), { params: Promise.resolve({ id: 'wh_123' }) })
    expect(res.status).toBe(404)
  })

  it('returns 403 if webhook belongs to another user', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
    userFindUnique.mockResolvedValue({ id: 'user-1' })
    webhookFindUnique.mockResolvedValue({ id: 'wh_123', userId: 'user-2' })

    const { POST } = await import('@/app/api/routes-d/webhooks/[id]/rotate-secret/route')
    const res = await POST(makeRequest('POST', 'wh_123'), { params: Promise.resolve({ id: 'wh_123' }) })
    expect(res.status).toBe(403)
  })

  it('returns 200 and rotates secret when successful', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
    userFindUnique.mockResolvedValue({ id: 'user-1' })
    webhookFindUnique.mockResolvedValue({ id: 'wh_123', userId: 'user-1' })
    webhookUpdate.mockResolvedValue({
      id: 'wh_123',
      targetUrl: 'https://myapp.com/wh',
      description: null,
      isActive: true,
      subscribedEvents: ['invoice.paid'],
      createdAt: new Date(),
    })

    const { POST } = await import('@/app/api/routes-d/webhooks/[id]/rotate-secret/route')
    const res = await POST(makeRequest('POST', 'wh_123'), { params: Promise.resolve({ id: 'wh_123' }) })

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toHaveProperty('signingSecret')
    expect(json.signingSecret).toHaveLength(64)
    expect(webhookUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'wh_123' },
        data: expect.objectContaining({
          signingSecret: expect.any(String),
        }),
      })
    )
  })
})
