import { describe, it, expect, beforeEach, vi } from 'vitest'
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

const BASE_URL = 'http://localhost/api/routes-d/api-keys'

function makeRequest(method: 'GET' | 'POST', body?: unknown, opts?: { auth?: string }) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const auth = opts?.auth ?? 'Bearer token'
  if (auth) headers.authorization = auth
  return new NextRequest(BASE_URL, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

describe('API Keys Endpoints', () => {
  beforeEach(() => vi.clearAllMocks())

  describe('GET /api/routes-d/api-keys', () => {
    it('returns 401 when no auth is supplied', async () => {
      const { GET } = await import('@/app/api/routes-d/api-keys/route')
      const res = await GET(makeRequest('GET', undefined, { auth: '' }))
      expect(res.status).toBe(401)
    })

    it('returns 200 and lists user api keys', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
      userFindUnique.mockResolvedValue({ id: 'user_1' })
      const mockKeys = [
        { id: 'key_1', name: 'Production', keyHint: 'lp_...1234', isActive: true },
      ]
      apiKeyFindMany.mockResolvedValue(mockKeys)

      const { GET } = await import('@/app/api/routes-d/api-keys/route')
      const res = await GET(makeRequest('GET'))
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.apiKeys).toEqual(mockKeys)
    })
  })

  describe('POST /api/routes-d/api-keys', () => {
    it('returns 401 when no auth is supplied', async () => {
      const { POST } = await import('@/app/api/routes-d/api-keys/route')
      const res = await POST(makeRequest('POST', { name: 'Test' }, { auth: '' }))
      expect(res.status).toBe(401)
    })

    it('returns 400 when name is missing', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
      userFindUnique.mockResolvedValue({ id: 'user_1' })

      const { POST } = await import('@/app/api/routes-d/api-keys/route')
      const res = await POST(makeRequest('POST', { name: '' }))
      expect(res.status).toBe(400)
    })

    it('returns 201 and creates key successfully', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
      userFindUnique.mockResolvedValue({ id: 'user_1' })

      const mockCreatedKey = {
        id: 'key_new',
        name: 'Development Key',
        keyHint: 'lp_...abcd',
        isActive: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      apiKeyCreate.mockResolvedValue(mockCreatedKey)

      const { POST } = await import('@/app/api/routes-d/api-keys/route')
      const res = await POST(makeRequest('POST', { name: 'Development Key' }))
      expect(res.status).toBe(201)
      const data = await res.json()
      expect(data.apiKey).toEqual(mockCreatedKey)
      expect(data.key).toContain('lp_')
    })
  })
})
