import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const webhookDeliveryFindUnique = vi.fn()
const webhookDeliveryUpdate = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    webhookDelivery: { findUnique: webhookDeliveryFindUnique, update: webhookDeliveryUpdate },
  },
}))

const BASE_URL = 'http://localhost/api/routes-d/webhooks/dead-letter'

function makeRequest(id: string) {
  return new NextRequest(`${BASE_URL}/${id}/retry`, {
    method: 'POST',
    headers: { authorization: 'Bearer token' },
  })
}

const mockUser = { id: 'user_1' }
const mockDelivery = {
  id: 'del_1',
  status: 'dead_lettered',
  attemptCount: 3,
  lastAttemptAt: new Date(Date.now() - 60_000), // 60s ago — past the 30s threshold
  eventType: 'invoice.paid',
  payload: '{}',
  webhook: { id: 'wh_1', userId: 'user_1', targetUrl: 'https://example.com/hook', isActive: true },
}

describe('POST /api/routes-d/webhooks/dead-letter/[id]/retry', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.resetModules() })

  it('returns 401 when unauthenticated', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-d/webhooks/dead-letter/[id]/retry/route')
    const res = await POST(makeRequest('del_1'), { params: { id: 'del_1' } })
    expect(res.status).toBe(401)
  })

  it('returns 404 when delivery does not exist', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(mockUser)
    webhookDeliveryFindUnique.mockResolvedValue(null)

    const { POST } = await import('@/app/api/routes-d/webhooks/dead-letter/[id]/retry/route')
    const res = await POST(makeRequest('nonexistent'), { params: { id: 'nonexistent' } })
    expect(res.status).toBe(404)
  })

  it('returns 404 when delivery belongs to another user', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(mockUser)
    webhookDeliveryFindUnique.mockResolvedValue({
      ...mockDelivery,
      webhook: { ...mockDelivery.webhook, userId: 'other_user' },
    })

    const { POST } = await import('@/app/api/routes-d/webhooks/dead-letter/[id]/retry/route')
    const res = await POST(makeRequest('del_1'), { params: { id: 'del_1' } })
    expect(res.status).toBe(404)
  })

  it('returns 409 when delivery is not dead-lettered or failed', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(mockUser)
    webhookDeliveryFindUnique.mockResolvedValue({ ...mockDelivery, status: 'delivered' })

    const { POST } = await import('@/app/api/routes-d/webhooks/dead-letter/[id]/retry/route')
    const res = await POST(makeRequest('del_1'), { params: { id: 'del_1' } })
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.error).toMatch(/dead-lettered or failed/i)
  })

  it('returns 429 when last retry was too recent', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(mockUser)
    webhookDeliveryFindUnique.mockResolvedValue({
      ...mockDelivery,
      lastAttemptAt: new Date(Date.now() - 5_000), // only 5s ago
    })

    const { POST } = await import('@/app/api/routes-d/webhooks/dead-letter/[id]/retry/route')
    const res = await POST(makeRequest('del_1'), { params: { id: 'del_1' } })
    expect(res.status).toBe(429)
    const json = await res.json()
    expect(json.error).toMatch(/wait/i)
  })

  it('queues delivery for retry successfully', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(mockUser)
    webhookDeliveryFindUnique.mockResolvedValue(mockDelivery)
    webhookDeliveryUpdate.mockResolvedValue({
      id: 'del_1',
      status: 'pending',
      attemptCount: 4,
      nextRetryAt: new Date(),
      updatedAt: new Date(),
    })

    const { POST } = await import('@/app/api/routes-d/webhooks/dead-letter/[id]/retry/route')
    const res = await POST(makeRequest('del_1'), { params: { id: 'del_1' } })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.message).toMatch(/retry/i)
    expect(json.delivery.status).toBe('pending')
  })
})
