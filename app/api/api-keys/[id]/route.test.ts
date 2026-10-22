import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DELETE } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    apiKey: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUser = { id: 'user-1', privyId: 'privy-1' }
const mockClaims = { userId: 'privy-1' }
const mockKey = {
  id: 'key-123',
  userId: 'user-1',
  name: 'Production Key',
  isActive: true,
}

function makeDeleteRequest(keyId = 'key-123', authHeader = 'Bearer token'): NextRequest {
  return new NextRequest(`http://localhost/api/api-keys/${keyId}`, {
    method: 'DELETE',
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
  vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(mockKey as any)
  vi.mocked(prisma.apiKey.update).mockResolvedValue({
    ...mockKey,
    isActive: false,
    updatedAt: new Date(),
  } as any)
})

describe('DELETE /api/api-keys/[id]', () => {
  it('successfully revokes an active API key owned by the caller (soft delete)', async () => {
    const req = makeDeleteRequest('key-123')
    const res = await DELETE(req, { params: Promise.resolve({ id: 'key-123' }) })

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.apiKey.isActive).toBe(false)

    expect(prisma.apiKey.update).toHaveBeenCalledWith({
      where: { id: 'key-123' },
      data: { isActive: false },
      select: expect.any(Object),
    })
  })

  it('rejects unauthorized requests when auth token is missing or invalid', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const req = makeDeleteRequest('key-123')
    const res = await DELETE(req, { params: Promise.resolve({ id: 'key-123' }) })

    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toBe('Unauthorized')
  })

  it('returns 404 when user is not found', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
    const req = makeDeleteRequest('key-123')
    const res = await DELETE(req, { params: Promise.resolve({ id: 'key-123' }) })

    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error).toBe('User not found')
  })

  it('returns 404 when API key does not exist', async () => {
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(null)
    const req = makeDeleteRequest('non-existent')
    const res = await DELETE(req, { params: Promise.resolve({ id: 'non-existent' }) })

    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error).toBe('API key not found')
  })

  it('returns 403 when user is not the owner of the key', async () => {
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue({
      ...mockKey,
      userId: 'different-user',
    } as any)
    const req = makeDeleteRequest('key-123')
    const res = await DELETE(req, { params: Promise.resolve({ id: 'key-123' }) })

    expect(res.status).toBe(403)
    const json = await res.json()
    expect(json.error).toMatch(/Forbidden/i)
  })

  it('returns 400 when attempting to revoke an already inactive key', async () => {
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue({
      ...mockKey,
      isActive: false,
    } as any)
    const req = makeDeleteRequest('key-123')
    const res = await DELETE(req, { params: Promise.resolve({ id: 'key-123' }) })

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe('API key is already revoked')
  })
})
