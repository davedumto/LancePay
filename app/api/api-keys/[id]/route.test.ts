import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { DELETE } from './route'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    apiKey: {
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}))

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return {
    ...actual,
    verifyAuthToken: vi.fn(),
  }
})

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
  },
}))

import { prisma } from '@/lib/db'
import {
  clearApiKeyRevocationCache,
  isApiKeyRevokedInCache,
  verifyAuthToken,
} from '@/lib/auth'

const mockUser = { id: 'user-1', privyId: 'privy-1', email: 'owner@example.com' }
const mockClaims = { userId: 'privy-1' }
const mockActiveKey = {
  id: 'key-1',
  userId: 'user-1',
  name: 'Production Integration Key',
  keyHint: 'a1b2c3',
  hashedKey: 'hashed-secret-key-1',
  isActive: true,
  deactivatesAt: null,
}

function makeDeleteRequest(
  keyId = 'key-1',
  withAuth = true,
): [NextRequest, { params: Promise<{ id: string }> }] {
  const headers: Record<string, string> = {}
  if (withAuth) headers.authorization = 'Bearer valid-token'
  return [
    new NextRequest(`http://localhost/api/api-keys/${keyId}`, {
      method: 'DELETE',
      headers,
    }),
    { params: Promise.resolve({ id: keyId }) },
  ]
}

describe('DELETE /api/api-keys/[id] (#1665)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearApiKeyRevocationCache()
    vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(mockActiveKey as any)
    vi.mocked(prisma.apiKey.update).mockImplementation(async ({ data }: any) => ({
      id: mockActiveKey.id,
      name: mockActiveKey.name,
      keyHint: mockActiveKey.keyHint,
      isActive: data.isActive,
      deactivatesAt: data.deactivatesAt,
      lastUsedAt: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date(),
    }) as any)
  })

  it('soft-revokes the API key (isActive=false), preserves the row for audit history, and invalidates the cache', async () => {
    const [req, ctx] = makeDeleteRequest('key-1')
    const res = await DELETE(req, ctx)
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.message).toBe('API key revoked successfully')
    expect(body.apiKey.id).toBe('key-1')
    expect(body.apiKey.isActive).toBe(false)
    expect(body.apiKey.revokedAt).toBeDefined()
    expect(body.apiKey.hashedKey).toBeUndefined()

    // Soft-revoke via update, never hard-delete
    expect(prisma.apiKey.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'key-1' },
        data: expect.objectContaining({
          isActive: false,
          deactivatesAt: expect.any(Date),
        }),
      }),
    )
    expect(prisma.apiKey.delete).not.toHaveBeenCalled()

    // Immediate request-time revocation cache invalidation
    expect(isApiKeyRevokedInCache('key-1', 'hashed-secret-key-1')).toBe(true)
  })

  it('returns 403 when a user attempts to revoke another user’s API key', async () => {
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue({
      ...mockActiveKey,
      userId: 'other-user-99',
    } as any)

    const [req, ctx] = makeDeleteRequest('key-1')
    const res = await DELETE(req, ctx)

    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toMatch(/do not own/i)
    expect(prisma.apiKey.update).not.toHaveBeenCalled()
    expect(isApiKeyRevokedInCache('key-1')).toBe(false)
  })

  it('returns 404 when the API key does not exist', async () => {
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(null)

    const [req, ctx] = makeDeleteRequest('nonexistent-key')
    const res = await DELETE(req, ctx)

    expect(res.status).toBe(404)
    expect(prisma.apiKey.update).not.toHaveBeenCalled()
  })

  it('returns 409 when the API key is already revoked', async () => {
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue({
      ...mockActiveKey,
      isActive: false,
    } as any)

    const [req, ctx] = makeDeleteRequest('key-1')
    const res = await DELETE(req, ctx)

    expect(res.status).toBe(409)
    expect(prisma.apiKey.update).not.toHaveBeenCalled()
  })

  it('returns 401 when unauthenticated or token is invalid', async () => {
    const [reqNoAuth, ctx] = makeDeleteRequest('key-1', false)
    const resNoAuth = await DELETE(reqNoAuth, ctx)
    expect(resNoAuth.status).toBe(401)

    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const [reqInvalid, ctx2] = makeDeleteRequest('key-1', true)
    const resInvalid = await DELETE(reqInvalid, ctx2)
    expect(resInvalid.status).toBe(401)
  })

  it('extracts keyId from the request URL when route context params are omitted', async () => {
    const [req] = makeDeleteRequest('key-1')
    const res = await DELETE(req)
    expect(res.status).toBe(200)
    expect(prisma.apiKey.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'key-1' },
      }),
    )
  })
})
