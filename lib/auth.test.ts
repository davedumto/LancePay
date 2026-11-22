import { describe, it, expect, vi, beforeEach } from 'vitest'
import { verifyApiKey, verifyAuthToken } from './auth'

const { mockPrivyVerify } = vi.hoisted(() => ({
  mockPrivyVerify: vi.fn(),
}))

vi.mock('@privy-io/server-auth', () => ({
  PrivyClient: class {
    verifyAuthToken = mockPrivyVerify
  },
}))

vi.mock('./crypto', () => ({
  hashToken: vi.fn(),
}))
vi.mock('./db', () => ({
  prisma: {
    apiKey: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    userSession: {
      upsert: vi.fn(),
    },
  },
}))

import { hashToken } from './crypto'
import { prisma } from './db'

const mockRawKey = 'test-raw-key-1234567890abcdef'
const mockHashedKey = 'hashed-test-key-value'
const mockApiKeyRecord = {
  id: 'key-1',
  userId: 'user-1',
  name: 'Test Key',
  isActive: true,
  deactivatesAt: null,
  lastUsedAt: null,
  createdAt: new Date(),
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(hashToken).mockReturnValue(mockHashedKey)
})

describe('verifyApiKey', () => {
  describe('Grace Period Validation', () => {
    it('validates key during active grace period (old key after rotation)', async () => {
      const now = new Date()
      const futureDeactivationTime = new Date(now.getTime() + 1000 * 60 * 60) // 1 hour in future

      const recordWithGracePeriod = {
        ...mockApiKeyRecord,
        deactivatesAt: futureDeactivationTime,
      }

      vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(recordWithGracePeriod as any)
      vi.mocked(prisma.apiKey.update).mockResolvedValue({} as any)

      const result = await verifyApiKey(mockRawKey)

      expect(result).not.toBeNull()
      expect(result?.userId).toBe('user-1')
      expect(result?.apiKey.id).toBe('key-1')
    })

    it('rejects key after grace period expires', async () => {
      const now = new Date()
      const pastDeactivationTime = new Date(now.getTime() - 1000 * 60) // 1 minute in past

      const recordWithExpiredGrace = {
        ...mockApiKeyRecord,
        deactivatesAt: pastDeactivationTime,
      }

      vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(recordWithExpiredGrace as any)

      const result = await verifyApiKey(mockRawKey)

      expect(result).toBeNull()
      // Should not have called update since grace period expired
      expect(vi.mocked(prisma.apiKey.update)).not.toHaveBeenCalled()
    })

    it('accepts key with no deactivatesAt (never rotated)', async () => {
      const neverRotatedKey = {
        ...mockApiKeyRecord,
        deactivatesAt: null,
      }

      vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(neverRotatedKey as any)
      vi.mocked(prisma.apiKey.update).mockResolvedValue({} as any)

      const result = await verifyApiKey(mockRawKey)

      expect(result).not.toBeNull()
      expect(result?.userId).toBe('user-1')
    })
  })

  describe('Active Status Validation', () => {
    it('rejects inactive keys regardless of grace period', async () => {
      const inactiveKey = {
        ...mockApiKeyRecord,
        isActive: false,
        deactivatesAt: new Date(Date.now() + 1000 * 60 * 60), // future time
      }

      vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(inactiveKey as any)

      const result = await verifyApiKey(mockRawKey)

      expect(result).toBeNull()
      expect(vi.mocked(prisma.apiKey.update)).not.toHaveBeenCalled()
    })
  })

  describe('Key Lookup & Hashing', () => {
    it('hashes the raw key before lookup', async () => {
      vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(mockApiKeyRecord as any)
      vi.mocked(prisma.apiKey.update).mockResolvedValue({} as any)

      await verifyApiKey(mockRawKey)

      expect(hashToken).toHaveBeenCalledWith(mockRawKey)
      expect(vi.mocked(prisma.apiKey.findUnique)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { hashedKey: mockHashedKey },
        })
      )
    })

    it('returns null when key not found in database', async () => {
      vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(null)

      const result = await verifyApiKey(mockRawKey)

      expect(result).toBeNull()
    })

    it('returns null for null/undefined input', async () => {
      const resultNull = await verifyApiKey(null as any)
      const resultUndefined = await verifyApiKey(undefined as any)

      expect(resultNull).toBeNull()
      expect(resultUndefined).toBeNull()

      // Should not query database for invalid input
      expect(vi.mocked(prisma.apiKey.findUnique)).not.toHaveBeenCalled()
    })
  })

  describe('LastUsedAt Tracking', () => {
    it('updates lastUsedAt on successful verification', async () => {
      vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(mockApiKeyRecord as any)
      vi.mocked(prisma.apiKey.update).mockResolvedValue({} as any)

      const beforeUpdate = Date.now()
      await verifyApiKey(mockRawKey)
      const afterUpdate = Date.now()

      expect(vi.mocked(prisma.apiKey.update)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'key-1' },
          data: expect.objectContaining({
            lastUsedAt: expect.any(Date),
          }),
        })
      )

      // Verify the timestamp is recent
      const updateCall = vi.mocked(prisma.apiKey.update).mock.calls[0][0]
      const lastUsedAtTime = updateCall.data.lastUsedAt.getTime()
      expect(lastUsedAtTime).toBeGreaterThanOrEqual(beforeUpdate)
      expect(lastUsedAtTime).toBeLessThanOrEqual(afterUpdate + 1000)
    })

    it('silently fails if lastUsedAt update fails', async () => {
      vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(mockApiKeyRecord as any)
      vi.mocked(prisma.apiKey.update).mockRejectedValue(new Error('DB error'))

      // Should not throw, should silently fail
      const result = await verifyApiKey(mockRawKey)

      expect(result).not.toBeNull()
      expect(result?.userId).toBe('user-1')
    })
  })

  describe('Error Handling', () => {
    it('returns null on database lookup error', async () => {
      vi.mocked(prisma.apiKey.findUnique).mockRejectedValue(new Error('DB connection failed'))

      const result = await verifyApiKey(mockRawKey)

      expect(result).toBeNull()
    })

    it('returns null on hashing error', async () => {
      vi.mocked(hashToken).mockImplementation(() => {
        throw new Error('Hash failed')
      })

      const result = await verifyApiKey(mockRawKey)

      expect(result).toBeNull()
    })
  })

  describe('Return Values', () => {
    it('returns userId and full apiKey record on success', async () => {
      vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(mockApiKeyRecord as any)
      vi.mocked(prisma.apiKey.update).mockResolvedValue({} as any)

      const result = await verifyApiKey(mockRawKey)

      expect(result).not.toBeNull()
      expect(result?.userId).toBe('user-1')
      expect(result?.apiKey).toBeDefined()
      expect(result?.apiKey.id).toBe('key-1')
      expect(result?.apiKey.name).toBe('Test Key')
      expect(result?.apiKey.isActive).toBe(true)
    })

    it('includes only selected fields in returned apiKey record', async () => {
      vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(mockApiKeyRecord as any)
      vi.mocked(prisma.apiKey.update).mockResolvedValue({} as any)

      const result = await verifyApiKey(mockRawKey)

      const returnedFields = Object.keys(result?.apiKey || {})
      expect(returnedFields).toContain('id')
      expect(returnedFields).toContain('userId')
      expect(returnedFields).toContain('name')
      expect(returnedFields).toContain('isActive')
      expect(returnedFields).toContain('deactivatesAt')
      expect(returnedFields).toContain('lastUsedAt')
      expect(returnedFields).toContain('createdAt')

      // Should not include hashedKey in returned value (security)
      expect(returnedFields).not.toContain('hashedKey')
    })
  })

  describe('Integration Scenarios', () => {
    it('handles newly created key (no deactivatesAt, no lastUsedAt)', async () => {
      const newKey = {
        ...mockApiKeyRecord,
        lastUsedAt: null,
        deactivatesAt: null,
      }

      vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(newKey as any)
      vi.mocked(prisma.apiKey.update).mockResolvedValue({} as any)

      const result = await verifyApiKey(mockRawKey)

      expect(result).not.toBeNull()
      expect(result?.userId).toBe('user-1')
    })

    it('handles rotated key at exact grace period boundary', async () => {
      const now = new Date()
      const exactBoundary = now // deactivatesAt == now

      const boundaryKey = {
        ...mockApiKeyRecord,
        deactivatesAt: exactBoundary,
      }

      vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(boundaryKey as any)

      const result = await verifyApiKey(mockRawKey)

      // At exact boundary (<=), key should be invalid
      expect(result).toBeNull()
    })

    it('handles key just before grace period expires', async () => {
      const now = new Date()
      const justBeforeExpiry = new Date(now.getTime() + 1) // 1ms in future

      const almostExpiredKey = {
        ...mockApiKeyRecord,
        deactivatesAt: justBeforeExpiry,
      }

      vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(almostExpiredKey as any)
      vi.mocked(prisma.apiKey.update).mockResolvedValue({} as any)

      const result = await verifyApiKey(mockRawKey)

      expect(result).not.toBeNull()
    })
  })
})

describe('verifyAuthToken', () => {
  const mockToken = 'mock-bearer-token'
  const mockClaims = {
    userId: 'privy-user-1',
    sessionId: 'session-xyz-123456789012',
    appId: 'test-app',
    issuedAt: Date.now(),
    expiration: Date.now() + 3600,
  }

  it('returns verified claims when token and session are active and valid', async () => {
    mockPrivyVerify.mockResolvedValue(mockClaims)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-db-1' } as any)
    vi.mocked(prisma.userSession.upsert).mockResolvedValue({
      userId: 'user-db-1',
      revokedAt: null,
    } as any)

    const result = await verifyAuthToken(mockToken)

    expect(result).toEqual(mockClaims)
    expect(mockPrivyVerify).toHaveBeenCalledWith(mockToken)
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { privyId: 'privy-user-1' },
      select: { id: true },
    })
    expect(prisma.userSession.upsert).toHaveBeenCalledWith({
      where: { providerSessionId: mockClaims.sessionId },
      create: {
        providerSessionId: mockClaims.sessionId,
        userId: 'user-db-1',
        tokenHint: '123456789012',
      },
      update: { lastSeenAt: expect.any(Date) },
      select: { userId: true, revokedAt: true },
    })
  })

  it('returns claims directly if claims do not contain a sessionId', async () => {
    const claimsWithoutSession = { userId: 'privy-user-1' }
    mockPrivyVerify.mockResolvedValue(claimsWithoutSession)

    const result = await verifyAuthToken(mockToken)

    expect(result).toEqual(claimsWithoutSession)
    expect(prisma.user.findUnique).not.toHaveBeenCalled()
  })

  it('returns claims directly if user does not exist in db yet', async () => {
    mockPrivyVerify.mockResolvedValue(mockClaims)
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)

    const result = await verifyAuthToken(mockToken)

    expect(result).toEqual(mockClaims)
    expect(prisma.userSession.upsert).not.toHaveBeenCalled()
  })

  it('returns null if session is revoked', async () => {
    mockPrivyVerify.mockResolvedValue(mockClaims)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-db-1' } as any)
    vi.mocked(prisma.userSession.upsert).mockResolvedValue({
      userId: 'user-db-1',
      revokedAt: new Date(),
    } as any)

    const result = await verifyAuthToken(mockToken)

    expect(result).toBeNull()
  })

  it('returns null if session userId does not match current user', async () => {
    mockPrivyVerify.mockResolvedValue(mockClaims)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-db-1' } as any)
    vi.mocked(prisma.userSession.upsert).mockResolvedValue({
      userId: 'different-user-db-2',
      revokedAt: null,
    } as any)

    const result = await verifyAuthToken(mockToken)

    expect(result).toBeNull()
  })

  it('returns null when PrivyClient throws an error (invalid/expired token)', async () => {
    mockPrivyVerify.mockRejectedValue(new Error('Invalid token'))

    const result = await verifyAuthToken(mockToken)

    expect(result).toBeNull()
  })
})
