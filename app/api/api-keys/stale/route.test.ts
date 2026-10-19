import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GET } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    apiKey: { findMany: vi.fn() },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'

function makeRequest(token: string | null = 'valid-token', days?: string): NextRequest {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (token) headers.set('authorization', `Bearer ${token}`)

  let url = 'http://localhost/api/api-keys/stale'
  if (days !== undefined) {
    url += `?days=${days}`
  }

  return new NextRequest(url, { method: 'GET', headers })
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/api-keys/stale', () => {
  describe('Authentication', () => {
    it('returns 401 when not authenticated', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue(null)

      const res = await GET(makeRequest(null))
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('Unauthorized')
    })

    it('returns 401 when token verification fails', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue(null)

      const res = await GET(makeRequest('invalid-token'))
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('Invalid token')
    })

    it('returns 404 when user not found', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_unknown' })
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null)

      const res = await GET(makeRequest())
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toBe('User not found')
    })
  })

  describe('Query parameter validation', () => {
    beforeEach(() => {
      vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_1' })
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user_1', role: 'freelancer' })
    })

    it('applies default staleness threshold (90 days) when days param is omitted', async () => {
      vi.mocked(prisma.apiKey.findMany).mockResolvedValue([])

      const res = await GET(makeRequest())
      expect(res.status).toBe(200)
      expect(vi.mocked(prisma.apiKey.findMany)).toHaveBeenCalled()
    })

    it('rejects non-numeric days parameter', async () => {
      const res = await GET(makeRequest(undefined, 'abc'))
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('must be a positive integer')
    })

    it('rejects negative days parameter', async () => {
      const res = await GET(makeRequest(undefined, '-30'))
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('must be a positive integer')
    })

    it('rejects zero days parameter', async () => {
      const res = await GET(makeRequest(undefined, '0'))
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('must be a positive integer')
    })

    it('accepts custom positive integer days parameter', async () => {
      vi.mocked(prisma.apiKey.findMany).mockResolvedValue([])

      const res = await GET(makeRequest(undefined, '60'))
      expect(res.status).toBe(200)
      expect(vi.mocked(prisma.apiKey.findMany)).toHaveBeenCalled()
    })
  })

  describe('Authorization & Access Control', () => {
    beforeEach(() => {
      vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_1' })
    })

    it('non-admin user gets only their own stale keys', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user_1', role: 'freelancer' })
      const staleDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)

      vi.mocked(prisma.apiKey.findMany).mockResolvedValue([
        {
          id: 'key_1',
          userId: 'user_1',
          name: 'Old Desktop',
          keyHint: 'abc123',
          isActive: true,
          lastUsedAt: staleDate,
          createdAt: new Date('2026-01-01'),
        },
      ])

      const res = await GET(makeRequest())
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.apiKeys).toHaveLength(1)

      const callArgs = vi.mocked(prisma.apiKey.findMany).mock.calls[0][0]
      expect(callArgs.where.userId).toBe('user_1')
    })

    it('admin user can see all users stale keys', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'admin_1', role: 'admin' })
      const staleDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)

      const allStaleKeys = [
        {
          id: 'key_1',
          userId: 'user_1',
          name: 'User 1 Old Key',
          keyHint: 'abc123',
          isActive: true,
          lastUsedAt: staleDate,
          createdAt: new Date('2026-01-01'),
        },
        {
          id: 'key_2',
          userId: 'user_2',
          name: 'User 2 Old Key',
          keyHint: 'def456',
          isActive: true,
          lastUsedAt: staleDate,
          createdAt: new Date('2026-01-02'),
        },
      ]

      vi.mocked(prisma.apiKey.findMany).mockResolvedValue(allStaleKeys)

      const res = await GET(makeRequest())
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.apiKeys).toHaveLength(2)
      expect(body.apiKeys[0].userId).toBe('user_1')
      expect(body.apiKeys[1].userId).toBe('user_2')

      const callArgs = vi.mocked(prisma.apiKey.findMany).mock.calls[0][0]
      expect(callArgs.where.userId).toBeUndefined()
    })
  })

  describe('Never-used keys', () => {
    beforeEach(() => {
      vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_1' })
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user_1', role: 'freelancer' })
    })

    it('includes keys with lastUsedAt null regardless of createdAt age', async () => {
      const recentlyCreated = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)

      vi.mocked(prisma.apiKey.findMany).mockResolvedValue([
        {
          id: 'key_never_used',
          userId: 'user_1',
          name: 'Never Used Key',
          keyHint: 'abc123',
          isActive: true,
          lastUsedAt: null,
          createdAt: recentlyCreated,
        },
      ])

      const res = await GET(makeRequest())
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.apiKeys).toHaveLength(1)
      expect(body.apiKeys[0].lastUsedAt).toBeNull()
    })
  })

  describe('Staleness threshold', () => {
    beforeEach(() => {
      vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_1' })
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user_1', role: 'freelancer' })
    })

    it('includes key used just before threshold boundary', async () => {
      const justOutsideThreshold = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000)

      vi.mocked(prisma.apiKey.findMany).mockResolvedValue([
        {
          id: 'key_1',
          userId: 'user_1',
          name: 'Outside Threshold',
          keyHint: 'abc123',
          isActive: true,
          lastUsedAt: justOutsideThreshold,
          createdAt: new Date('2026-01-01'),
        },
      ])

      const res = await GET(makeRequest())
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.apiKeys).toHaveLength(1)
    })

    it('excludes key used within threshold boundary', async () => {
      vi.mocked(prisma.apiKey.findMany).mockResolvedValue([])

      const res = await GET(makeRequest())
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.apiKeys).toHaveLength(0)
    })
  })

  describe('Empty results', () => {
    beforeEach(() => {
      vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_1' })
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user_1', role: 'freelancer' })
    })

    it('returns empty apiKeys array when no stale keys exist', async () => {
      vi.mocked(prisma.apiKey.findMany).mockResolvedValue([])

      const res = await GET(makeRequest())
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.apiKeys).toEqual([])
    })

    it('admin returns empty apiKeys array when no stale keys exist across all users', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'admin_1', role: 'admin' })
      vi.mocked(prisma.apiKey.findMany).mockResolvedValue([])

      const res = await GET(makeRequest())
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.apiKeys).toEqual([])
    })
  })

  describe('Response structure', () => {
    beforeEach(() => {
      vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_1' })
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user_1', role: 'freelancer' })
    })

    it('returns correct response structure with all key fields', async () => {
      const createdDate = new Date('2026-01-01T00:00:00Z')
      const lastUsedDate = new Date('2026-06-01T00:00:00Z')

      vi.mocked(prisma.apiKey.findMany).mockResolvedValue([
        {
          id: 'key_1',
          userId: 'user_1',
          name: 'Test Key',
          keyHint: 'abc123',
          isActive: true,
          lastUsedAt: lastUsedDate,
          createdAt: createdDate,
        },
      ])

      const res = await GET(makeRequest())
      expect(res.status).toBe(200)
      const body = await res.json()

      expect(body).toHaveProperty('apiKeys')
      expect(Array.isArray(body.apiKeys)).toBe(true)
      expect(body.apiKeys[0]).toMatchObject({
        id: 'key_1',
        userId: 'user_1',
        name: 'Test Key',
        keyHint: 'abc123',
        isActive: true,
        lastUsedAt: lastUsedDate.toISOString(),
        createdAt: createdDate.toISOString(),
      })
    })
  })

  describe('Happy path full scenarios', () => {
    it('admin receives stale keys across multiple users with custom threshold', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_admin' })
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'admin_1', role: 'admin' })
      const sixtyFiveDaysAgo = new Date(Date.now() - 65 * 24 * 60 * 60 * 1000)

      const staleKeys = [
        {
          id: 'key_1',
          userId: 'user_1',
          name: 'User 1 Key',
          keyHint: 'abc123',
          isActive: true,
          lastUsedAt: sixtyFiveDaysAgo,
          createdAt: new Date('2026-01-01'),
        },
        {
          id: 'key_2',
          userId: 'user_2',
          name: 'User 2 Key',
          keyHint: 'def456',
          isActive: false,
          lastUsedAt: null,
          createdAt: new Date('2026-01-02'),
        },
      ]

      vi.mocked(prisma.apiKey.findMany).mockResolvedValue(staleKeys)

      const res = await GET(makeRequest(undefined, '60'))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.apiKeys).toHaveLength(2)
      expect(body.apiKeys).toEqual(staleKeys)
    })

    it('non-admin receives only their own stale keys and cannot see others', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_user1' })
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user_1', role: 'freelancer' })
      const staleDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)

      const userStaleKeys = [
        {
          id: 'key_1',
          userId: 'user_1',
          name: 'My Old Key',
          keyHint: 'abc123',
          isActive: true,
          lastUsedAt: staleDate,
          createdAt: new Date('2026-01-01'),
        },
      ]

      vi.mocked(prisma.apiKey.findMany).mockResolvedValue(userStaleKeys)

      const res = await GET(makeRequest())
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.apiKeys).toHaveLength(1)
      expect(body.apiKeys[0].userId).toBe('user_1')

      const callArgs = vi.mocked(prisma.apiKey.findMany).mock.calls[0][0]
      expect(callArgs.where.userId).toBe('user_1')
    })
  })
})
