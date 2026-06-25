import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const apiKeyFindMany = vi.fn()
const apiKeyCreate = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    apiKey: { findMany: apiKeyFindMany, create: apiKeyCreate },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

function makeRequest(method: 'GET' | 'POST', body?: unknown, token: string | null = 'valid-token') {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (token) headers.set('authorization', `Bearer ${token}`)
  return new NextRequest('http://localhost/api/routes-d/api-keys', {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

describe('API keys route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when not authenticated', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-d/api-keys/route')
    const res = await GET(makeRequest('GET', undefined, null))
    expect(res.status).toBe(401)
  })

  it('lists the caller API keys', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1', role: 'freelancer' })
    apiKeyFindMany.mockResolvedValue([
      { id: 'key_1', name: 'Desktop', keyHint: 'abc123', isActive: true, lastUsedAt: null, createdAt: new Date(), updatedAt: new Date() },
    ])

    const { GET } = await import('@/app/api/routes-d/api-keys/route')
    const res = await GET(makeRequest('GET'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.apiKeys).toHaveLength(1)
    expect(apiKeyFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user_1' } }))
  })

  it('rejects invalid create payloads', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1', role: 'freelancer' })
    const { POST } = await import('@/app/api/routes-d/api-keys/route')
    const res = await POST(makeRequest('POST', { name: '' }))
    expect(res.status).toBe(400)
    expect(apiKeyCreate).not.toHaveBeenCalled()
  })

  it('creates an API key and returns the raw secret once', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1', role: 'freelancer' })
    apiKeyCreate.mockResolvedValue({
      id: 'key_1',
      name: 'Desktop',
      keyHint: 'abc123',
      isActive: true,
      lastUsedAt: null,
      createdAt: new Date('2026-06-24T00:00:00Z'),
      updatedAt: new Date('2026-06-24T00:00:00Z'),
    })

    const { POST } = await import('@/app/api/routes-d/api-keys/route')
    const res = await POST(makeRequest('POST', { name: 'Desktop' }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.apiKey).toMatch(/^rk_/)
    expect(body.key).toMatchObject({ id: 'key_1', name: 'Desktop', keyHint: 'abc123' })
    expect(apiKeyCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: 'user_1', name: 'Desktop', isActive: true }),
    }))
  })
})
