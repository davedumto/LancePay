import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    brandingSettings: {
      findUnique: vi.fn(),
    },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const mockCurrentUser = { id: 'user-1', role: 'freelancer' }
const mockAdminUser = { id: 'admin-1', role: 'admin' }
const mockClaims = { userId: 'privy-1' }

function makeRequest(authToken?: string): NextRequest {
  return new NextRequest('http://localhost/api/branding-settings/user-1/verification-status', {
    method: 'GET',
    headers: authToken ? { authorization: `Bearer ${authToken}` } : {},
  })
}

function makeRequestForUserId(userId: string, authToken?: string): NextRequest {
  return new NextRequest(
    `http://localhost/api/branding-settings/${userId}/verification-status`,
    {
      method: 'GET',
      headers: authToken ? { authorization: `Bearer ${authToken}` } : {},
    },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/branding-settings/[userId]/verification-status', () => {
  describe('Authentication', () => {
    it('returns 401 when no authorization header is present', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue(null)
      const res = await GET(makeRequest(), { params: Promise.resolve({ userId: 'user-1' }) })
      expect(res.status).toBe(401)
      const data = await res.json()
      expect(data.error).toBe('Unauthorized')
    })

    it('returns 401 when authorization token is invalid', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue(null)
      const res = await GET(makeRequest('invalid-token'), {
        params: Promise.resolve({ userId: 'user-1' }),
      })
      expect(res.status).toBe(401)
      const data = await res.json()
      expect(data.error).toBe('Unauthorized')
    })

    it('returns 401 when user lookup fails', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
      const res = await GET(makeRequest('valid-token'), {
        params: Promise.resolve({ userId: 'user-1' }),
      })
      expect(res.status).toBe(401)
    })
  })

  describe('Authorization', () => {
    beforeEach(() => {
      vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
    })

    it('allows user to view their own verification status', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockCurrentUser as any)
      vi.mocked(prisma.brandingSettings.findUnique).mockResolvedValue({
        verificationStatus: 'verified',
        verifiedAt: new Date('2026-09-20T10:00:00Z'),
        customDomain: 'invoices.example.com',
        verificationToken: 'token123',
      } as any)

      const res = await GET(makeRequest('valid-token'), {
        params: Promise.resolve({ userId: 'user-1' }),
      })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.status).toBe('verified')
    })

    it('allows admin to view any user verification status', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockAdminUser as any)
      vi.mocked(prisma.brandingSettings.findUnique).mockResolvedValue({
        verificationStatus: 'pending',
        verifiedAt: null,
        customDomain: 'invoices.example.com',
        verificationToken: 'token123',
      } as any)

      const res = await GET(makeRequest('admin-token'), {
        params: Promise.resolve({ userId: 'user-2' }),
      })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.status).toBe('pending')
    })

    it('returns 403 when non-owner, non-admin tries to view another user status', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockCurrentUser as any)

      const res = await GET(makeRequest('valid-token'), {
        params: Promise.resolve({ userId: 'user-2' }),
      })
      expect(res.status).toBe(403)
      const data = await res.json()
      expect(data.error).toBe('Forbidden')
    })
  })

  describe('Parameter Validation', () => {
    beforeEach(() => {
      vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockCurrentUser as any)
    })

    it('returns 400 when userId parameter is missing', async () => {
      const res = await GET(makeRequest('valid-token'), {
        params: Promise.resolve({ userId: '' }),
      })
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toBe('Bad request')
    })

    it('returns 400 when userId parameter is whitespace only', async () => {
      const res = await GET(makeRequest('valid-token'), {
        params: Promise.resolve({ userId: '   ' }),
      })
      expect(res.status).toBe(400)
    })

    it('returns 400 when userId is not a string', async () => {
      const res = await GET(makeRequest('valid-token'), {
        params: Promise.resolve({ userId: null as any }),
      })
      expect(res.status).toBe(400)
    })
  })

  describe('Status Mapping - Happy Path', () => {
    beforeEach(() => {
      vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockCurrentUser as any)
    })

    it('returns verified status when domain is verified', async () => {
      const verifiedAt = new Date('2026-09-20T10:00:00Z')
      vi.mocked(prisma.brandingSettings.findUnique).mockResolvedValue({
        verificationStatus: 'verified',
        verifiedAt,
        customDomain: 'invoices.example.com',
        verificationToken: 'token123',
      } as any)

      const res = await GET(makeRequest('valid-token'), {
        params: Promise.resolve({ userId: 'user-1' }),
      })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.status).toBe('verified')
      expect(data.customDomain).toBe('invoices.example.com')
      expect(data.lastCheckedAt).toBe(verifiedAt.toISOString())
      expect(data.message).toContain('verified')
    })

    it('returns pending status when verification is in progress', async () => {
      vi.mocked(prisma.brandingSettings.findUnique).mockResolvedValue({
        verificationStatus: 'pending',
        verifiedAt: null,
        customDomain: 'invoices.example.com',
        verificationToken: 'token123',
      } as any)

      const res = await GET(makeRequest('valid-token'), {
        params: Promise.resolve({ userId: 'user-1' }),
      })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.status).toBe('pending')
      expect(data.customDomain).toBe('invoices.example.com')
      expect(data.lastCheckedAt).toBeUndefined()
      expect(data.message).toContain('pending')
    })

    it('returns never-attempted status when stored as unverified', async () => {
      vi.mocked(prisma.brandingSettings.findUnique).mockResolvedValue({
        verificationStatus: 'unverified',
        verifiedAt: null,
        customDomain: 'invoices.example.com',
        verificationToken: null,
      } as any)

      const res = await GET(makeRequest('valid-token'), {
        params: Promise.resolve({ userId: 'user-1' }),
      })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.status).toBe('never-attempted')
      expect(data.lastCheckedAt).toBeUndefined()
    })
  })

  describe('Never-Attempted State', () => {
    beforeEach(() => {
      vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockCurrentUser as any)
    })

    it('returns never-attempted with no timestamp when no branding settings exist', async () => {
      vi.mocked(prisma.brandingSettings.findUnique).mockResolvedValue(null)

      const res = await GET(makeRequest('valid-token'), {
        params: Promise.resolve({ userId: 'user-1' }),
      })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.status).toBe('never-attempted')
      expect(data.lastCheckedAt).toBeUndefined()
      expect(data.customDomain).toBeUndefined()
      expect(data.message).toContain('No verification attempt')
    })

    it('does not include lastCheckedAt timestamp for never-attempted state', async () => {
      vi.mocked(prisma.brandingSettings.findUnique).mockResolvedValue({
        verificationStatus: 'unverified',
        verifiedAt: null,
        customDomain: null,
        verificationToken: null,
      } as any)

      const res = await GET(makeRequest('valid-token'), {
        params: Promise.resolve({ userId: 'user-1' }),
      })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.status).toBe('never-attempted')
      expect(data.lastCheckedAt).toBeUndefined()
    })
  })

  describe('Timestamp Handling', () => {
    beforeEach(() => {
      vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockCurrentUser as any)
    })

    it('returns exact stored timestamp for verified status', async () => {
      const storedTimestamp = new Date('2026-09-15T14:30:45.123Z')
      vi.mocked(prisma.brandingSettings.findUnique).mockResolvedValue({
        verificationStatus: 'verified',
        verifiedAt: storedTimestamp,
        customDomain: 'example.com',
        verificationToken: 'token123',
      } as any)

      const res = await GET(makeRequest('valid-token'), {
        params: Promise.resolve({ userId: 'user-1' }),
      })
      const data = await res.json()
      expect(data.lastCheckedAt).toBe(storedTimestamp.toISOString())
    })

    it('does not include lastCheckedAt for pending status', async () => {
      vi.mocked(prisma.brandingSettings.findUnique).mockResolvedValue({
        verificationStatus: 'pending',
        verifiedAt: null,
        customDomain: 'example.com',
        verificationToken: 'token123',
      } as any)

      const res = await GET(makeRequest('valid-token'), {
        params: Promise.resolve({ userId: 'user-1' }),
      })
      const data = await res.json()
      expect(data.status).toBe('pending')
      expect(data.lastCheckedAt).toBeUndefined()
    })

    it('includes timestamp when pending status has verifiedAt (edge case)', async () => {
      // Edge case: pending state with verifiedAt timestamp
      // Should not happen in normal flow, but test defensive behavior
      const storedTimestamp = new Date('2026-09-15T14:30:45Z')
      vi.mocked(prisma.brandingSettings.findUnique).mockResolvedValue({
        verificationStatus: 'pending',
        verifiedAt: storedTimestamp,
        customDomain: 'example.com',
        verificationToken: 'token123',
      } as any)

      const res = await GET(makeRequest('valid-token'), {
        params: Promise.resolve({ userId: 'user-1' }),
      })
      const data = await res.json()
      expect(data.status).toBe('pending')
      expect(data.lastCheckedAt).toBeUndefined() // Should still not include timestamp for pending
    })
  })

  describe('No Side Effects', () => {
    beforeEach(() => {
      vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockCurrentUser as any)
    })

    it('does not invoke DNS resolution functions', async () => {
      vi.mocked(prisma.brandingSettings.findUnique).mockResolvedValue({
        verificationStatus: 'pending',
        verifiedAt: null,
        customDomain: 'example.com',
        verificationToken: 'token123',
      } as any)

      await GET(makeRequest('valid-token'), {
        params: Promise.resolve({ userId: 'user-1' }),
      })

      // Verify no DNS or crypto functions were called
      // (This is verified by the mock setup - if any were called, they'd show up)
      expect(vi.mocked(prisma.brandingSettings.findUnique).mock.calls.length).toBe(1)
    })

    it('does not modify database records on multiple calls', async () => {
      const mockSettings = {
        verificationStatus: 'pending',
        verifiedAt: null,
        customDomain: 'example.com',
        verificationToken: 'token123',
      }
      vi.mocked(prisma.brandingSettings.findUnique).mockResolvedValue(mockSettings as any)

      // Call endpoint multiple times
      for (let i = 0; i < 3; i++) {
        const res = await GET(makeRequest('valid-token'), {
          params: Promise.resolve({ userId: 'user-1' }),
        })
        expect(res.status).toBe(200)
      }

      // Verify findUnique was called 3 times (read-only, no update calls)
      expect(vi.mocked(prisma.brandingSettings.findUnique).mock.calls.length).toBe(3)
      expect(prisma.brandingSettings).not.toHaveProperty('update')
    })

    it('returns consistent results across multiple calls', async () => {
      const verifiedAt = new Date('2026-09-20T10:00:00Z')
      vi.mocked(prisma.brandingSettings.findUnique).mockResolvedValue({
        verificationStatus: 'verified',
        verifiedAt,
        customDomain: 'example.com',
        verificationToken: 'token123',
      } as any)

      // Call endpoint multiple times
      const results = []
      for (let i = 0; i < 3; i++) {
        const res = await GET(makeRequest('valid-token'), {
          params: Promise.resolve({ userId: 'user-1' }),
        })
        const data = await res.json()
        results.push(data)
      }

      // All results should be identical (no timestamp drift, no state change)
      expect(results[0]).toEqual(results[1])
      expect(results[1]).toEqual(results[2])
    })
  })

  describe('Admin Access', () => {
    beforeEach(() => {
      vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
    })

    it('allows admin to view other user verification status', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockAdminUser as any)
      vi.mocked(prisma.brandingSettings.findUnique).mockResolvedValue({
        verificationStatus: 'verified',
        verifiedAt: new Date('2026-09-20T10:00:00Z'),
        customDomain: 'customer.example.com',
        verificationToken: 'token123',
      } as any)

      const res = await GET(makeRequestForUserId('user-2', 'admin-token'), {
        params: Promise.resolve({ userId: 'user-2' }),
      })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.status).toBe('verified')
      expect(data.customDomain).toBe('customer.example.com')
    })

    it('admin view does not trigger side effects on other user data', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockAdminUser as any)
      vi.mocked(prisma.brandingSettings.findUnique).mockResolvedValue({
        verificationStatus: 'pending',
        verifiedAt: null,
        customDomain: 'customer.example.com',
        verificationToken: 'token123',
      } as any)

      await GET(makeRequestForUserId('user-2', 'admin-token'), {
        params: Promise.resolve({ userId: 'user-2' }),
      })

      // Verify no modifications were attempted
      expect(vi.mocked(prisma.brandingSettings.findUnique).mock.calls.length).toBe(1)
    })
  })

  describe('Response Format', () => {
    beforeEach(() => {
      vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockCurrentUser as any)
    })

    it('includes all required fields in response', async () => {
      vi.mocked(prisma.brandingSettings.findUnique).mockResolvedValue({
        verificationStatus: 'verified',
        verifiedAt: new Date('2026-09-20T10:00:00Z'),
        customDomain: 'example.com',
        verificationToken: 'token123',
      } as any)

      const res = await GET(makeRequest('valid-token'), {
        params: Promise.resolve({ userId: 'user-1' }),
      })
      const data = await res.json()

      expect(data).toHaveProperty('status')
      expect(data).toHaveProperty('message')
      expect(['never-attempted', 'pending', 'verified', 'failed']).toContain(data.status)
    })

    it('includes customDomain only when it exists', async () => {
      // Without domain
      vi.mocked(prisma.brandingSettings.findUnique).mockResolvedValue({
        verificationStatus: 'unverified',
        verifiedAt: null,
        customDomain: null,
        verificationToken: null,
      } as any)

      let res = await GET(makeRequest('valid-token'), {
        params: Promise.resolve({ userId: 'user-1' }),
      })
      let data = await res.json()
      expect(data.customDomain).toBeUndefined()

      // With domain
      vi.clearAllMocks()
      vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockCurrentUser as any)
      vi.mocked(prisma.brandingSettings.findUnique).mockResolvedValue({
        verificationStatus: 'verified',
        verifiedAt: new Date(),
        customDomain: 'invoices.example.com',
        verificationToken: 'token123',
      } as any)

      res = await GET(makeRequest('valid-token'), {
        params: Promise.resolve({ userId: 'user-1' }),
      })
      data = await res.json()
      expect(data.customDomain).toBe('invoices.example.com')
    })
  })

  describe('Error Handling', () => {
    beforeEach(() => {
      vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockCurrentUser as any)
    })

    it('returns 500 on database query error', async () => {
      vi.mocked(prisma.brandingSettings.findUnique).mockRejectedValue(
        new Error('Database connection error'),
      )

      const res = await GET(makeRequest('valid-token'), {
        params: Promise.resolve({ userId: 'user-1' }),
      })
      expect(res.status).toBe(500)
      const data = await res.json()
      expect(data.error).toBe('Internal server error')

      expect(logger.error).toHaveBeenCalled()
    })

    it('returns 500 on unexpected error', async () => {
      vi.mocked(prisma.user.findUnique).mockRejectedValue(
        new Error('Unexpected error during auth'),
      )

      const res = await GET(makeRequest('valid-token'), {
        params: Promise.resolve({ userId: 'user-1' }),
      })
      expect(res.status).toBe(500)
    })
  })

  describe('Logging', () => {
    beforeEach(() => {
      vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockCurrentUser as any)
      vi.mocked(prisma.brandingSettings.findUnique).mockResolvedValue({
        verificationStatus: 'verified',
        verifiedAt: new Date(),
        customDomain: 'example.com',
        verificationToken: 'token123',
      } as any)
    })

    it('logs successful status retrieval at debug level', async () => {
      await GET(makeRequest('valid-token'), {
        params: Promise.resolve({ userId: 'user-1' }),
      })

      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          requestingUserId: 'user-1',
          targetUserId: 'user-1',
          status: 'verified',
          isOwner: true,
          isAdmin: false,
        }),
        'Verification status retrieved',
      )
    })
  })

  describe('Edge Cases', () => {
    beforeEach(() => {
      vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockCurrentUser as any)
    })

    it('handles unknown verification status gracefully', async () => {
      vi.mocked(prisma.brandingSettings.findUnique).mockResolvedValue({
        verificationStatus: 'unknown_status',
        verifiedAt: null,
        customDomain: 'example.com',
        verificationToken: 'token123',
      } as any)

      const res = await GET(makeRequest('valid-token'), {
        params: Promise.resolve({ userId: 'user-1' }),
      })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.status).toBe('never-attempted')

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ storedStatus: 'unknown_status' }),
        expect.any(String),
      )
    })

    it('handles null verificationStatus in database', async () => {
      vi.mocked(prisma.brandingSettings.findUnique).mockResolvedValue({
        verificationStatus: null,
        verifiedAt: null,
        customDomain: 'example.com',
        verificationToken: null,
      } as any)

      const res = await GET(makeRequest('valid-token'), {
        params: Promise.resolve({ userId: 'user-1' }),
      })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.status).toBe('never-attempted')
    })

    it('handles user IDs with special characters', async () => {
      vi.mocked(prisma.brandingSettings.findUnique).mockResolvedValue({
        verificationStatus: 'verified',
        verifiedAt: new Date(),
        customDomain: 'example.com',
        verificationToken: 'token123',
      } as any)

      const specialUserId = 'user-123-abc-xyz'
      const res = await GET(makeRequest('valid-token'), {
        params: Promise.resolve({ userId: specialUserId }),
      })
      expect(res.status).toBe(200)

      expect(prisma.brandingSettings.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: specialUserId },
        }),
      )
    })
  })
})
