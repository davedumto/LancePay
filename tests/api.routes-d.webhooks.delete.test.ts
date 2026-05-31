import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const webhookFindUnique = vi.fn()
const webhookDelete = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    userWebhook: { findUnique: webhookFindUnique, delete: webhookDelete },
  },
}))

const BASE_URL = 'http://localhost/api/routes-d/webhooks'

function makeRequest(method: string, id: string, token: string | null = 'valid-token') {
  const headers = new Headers()
  if (token) {
    headers.set('authorization', `Bearer ${token}`)
  }
  return new NextRequest(`${BASE_URL}/${id}`, {
    method,
    headers,
  })
}

describe('DELETE /api/routes-d/webhooks/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 if no authorization header is provided', async () => {
    const { DELETE } = await import('@/app/api/routes-d/webhooks/[id]/route')
    const res = await DELETE(makeRequest('DELETE', 'wh_123', null), { params: Promise.resolve({ id: 'wh_123' }) })
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toBe('Unauthorized')
  })

  it('returns 404 if webhook does not exist', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
    userFindUnique.mockResolvedValue({ id: 'user-1' })
    webhookFindUnique.mockResolvedValue(null)
    
    const { DELETE } = await import('@/app/api/routes-d/webhooks/[id]/route')
    const res = await DELETE(makeRequest('DELETE', 'wh_123'), { params: Promise.resolve({ id: 'wh_123' }) })
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error).toBe('Webhook not found')
  })

  it('returns 403 if webhook belongs to another user', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
    userFindUnique.mockResolvedValue({ id: 'user-1' })
    webhookFindUnique.mockResolvedValue({ id: 'wh_123', userId: 'user-2' })
    
    const { DELETE } = await import('@/app/api/routes-d/webhooks/[id]/route')
    const res = await DELETE(makeRequest('DELETE', 'wh_123'), { params: Promise.resolve({ id: 'wh_123' }) })
    expect(res.status).toBe(403)
    const json = await res.json()
    expect(json.error).toBe('Forbidden')
  })

  it('returns 204 and deletes webhook when successful', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
    userFindUnique.mockResolvedValue({ id: 'user-1' })
    webhookFindUnique.mockResolvedValue({ id: 'wh_123', userId: 'user-1' })
    
    const { DELETE } = await import('@/app/api/routes-d/webhooks/[id]/route')
    const res = await DELETE(makeRequest('DELETE', 'wh_123'), { params: Promise.resolve({ id: 'wh_123' }) })
    
    expect(res.status).toBe(204)
    expect(webhookDelete).toHaveBeenCalledWith({ where: { id: 'wh_123' } })
  })

  it('returns 500 on unexpected error', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
    userFindUnique.mockRejectedValue(new Error('DB error'))
    
    const { DELETE } = await import('@/app/api/routes-d/webhooks/[id]/route')
    const res = await DELETE(makeRequest('DELETE', 'wh_123'), { params: Promise.resolve({ id: 'wh_123' }) })
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.error).toBe('Failed to delete webhook')
  })
})
