import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GET } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    kycApplication: { findUnique: vi.fn() },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'

function makeRequest(token: string | null = 'valid-token'): NextRequest {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (token) headers.set('authorization', `Bearer ${token}`)

  return new NextRequest('http://localhost/api/kyc/status', {
    method: 'GET',
    headers,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/kyc/status', () => {
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
      expect(body.error).toBe('Unauthorized')
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

  describe('No application state', () => {
    beforeEach(() => {
      vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_1' })
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user_1' })
    })

    it('returns no-application status when user has never submitted', async () => {
      vi.mocked(prisma.kycApplication.findUnique).mockResolvedValue(null)

      const res = await GET(makeRequest())
      expect(res.status).toBe(200)
      const body = await res.json()

      expect(body.status).toBe('no-application')
      expect(body.level).toBeNull()
      expect(body.rejectionReason).toBeUndefined()
    })
  })

  describe('Pending status', () => {
    beforeEach(() => {
      vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_1' })
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user_1' })
    })

    it('returns pending status with level', async () => {
      vi.mocked(prisma.kycApplication.findUnique).mockResolvedValue({
        status: 'pending',
        level: 'basic',
        rejectionReason: null,
      })

      const res = await GET(makeRequest())
      expect(res.status).toBe(200)
      const body = await res.json()

      expect(body.status).toBe('pending')
      expect(body.level).toBe('basic')
      expect(body.rejectionReason).toBeUndefined()
    })
  })

  describe('Approved status', () => {
    beforeEach(() => {
      vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_1' })
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user_1' })
    })

    it('returns approved status with level', async () => {
      vi.mocked(prisma.kycApplication.findUnique).mockResolvedValue({
        status: 'approved',
        level: 'enhanced',
        rejectionReason: null,
      })

      const res = await GET(makeRequest())
      expect(res.status).toBe(200)
      const body = await res.json()

      expect(body.status).toBe('approved')
      expect(body.level).toBe('enhanced')
      expect(body.rejectionReason).toBeUndefined()
    })
  })

  describe('Rejected status', () => {
    beforeEach(() => {
      vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_1' })
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user_1' })
    })

    it('includes rejectionReason when status is rejected', async () => {
      const reason = 'Document verification failed: missing government ID'
      vi.mocked(prisma.kycApplication.findUnique).mockResolvedValue({
        status: 'rejected',
        level: 'basic',
        rejectionReason: reason,
      })

      const res = await GET(makeRequest())
      expect(res.status).toBe(200)
      const body = await res.json()

      expect(body.status).toBe('rejected')
      expect(body.level).toBe('basic')
      expect(body.rejectionReason).toBe(reason)
    })

    it('does not include rejectionReason when it is null', async () => {
      vi.mocked(prisma.kycApplication.findUnique).mockResolvedValue({
        status: 'rejected',
        level: 'basic',
        rejectionReason: null,
      })

      const res = await GET(makeRequest())
      expect(res.status).toBe(200)
      const body = await res.json()

      expect(body.status).toBe('rejected')
      expect(body.level).toBe('basic')
      expect(body.rejectionReason).toBeUndefined()
    })
  })

  describe('Owner-only access', () => {
    it('restricts access to only the authenticated user\'s application', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_user1' })
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user_1' })

      vi.mocked(prisma.kycApplication.findUnique).mockResolvedValue({
        status: 'pending',
        level: 'basic',
        rejectionReason: null,
      })

      const res = await GET(makeRequest())
      expect(res.status).toBe(200)

      // Verify the query was filtered by the authenticated user's ID
      const findUniqueCall = vi.mocked(prisma.kycApplication.findUnique).mock.calls[0][0]
      expect(findUniqueCall.where.userId).toBe('user_1')
    })
  })

  describe('Response structure', () => {
    beforeEach(() => {
      vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_1' })
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user_1' })
    })

    it('returns correct response structure for approved application', async () => {
      vi.mocked(prisma.kycApplication.findUnique).mockResolvedValue({
        status: 'approved',
        level: 'enhanced',
        rejectionReason: null,
      })

      const res = await GET(makeRequest())
      expect(res.status).toBe(200)
      const body = await res.json()

      expect(body).toHaveProperty('status')
      expect(body).toHaveProperty('level')
      expect(typeof body.status).toBe('string')
      expect(typeof body.level).toBe('string')
    })
  })

  describe('Error handling', () => {
    beforeEach(() => {
      vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_1' })
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user_1' })
    })

    it('returns 500 on database error', async () => {
      vi.mocked(prisma.kycApplication.findUnique).mockRejectedValue(
        new Error('Database connection failed')
      )

      const res = await GET(makeRequest())
      expect(res.status).toBe(500)
      const body = await res.json()
      expect(body.error).toBe('Failed to retrieve KYC status')
    })

    it('does not expose error details in response', async () => {
      vi.mocked(prisma.kycApplication.findUnique).mockRejectedValue(
        new Error('Internal DB error')
      )

      const res = await GET(makeRequest())
      const body = await res.json()

      expect(body.error).not.toContain('Internal DB error')
    })
  })

  describe('Happy path scenarios', () => {
    it('new user with no application can check status', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_newuser' })
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user_new' })
      vi.mocked(prisma.kycApplication.findUnique).mockResolvedValue(null)

      const res = await GET(makeRequest())
      expect(res.status).toBe(200)
      const body = await res.json()

      expect(body.status).toBe('no-application')
      expect(body.level).toBeNull()
    })

    it('user with pending application can check status', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_user1' })
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user_1' })
      vi.mocked(prisma.kycApplication.findUnique).mockResolvedValue({
        status: 'pending',
        level: 'basic',
        rejectionReason: null,
      })

      const res = await GET(makeRequest())
      expect(res.status).toBe(200)
      const body = await res.json()

      expect(body.status).toBe('pending')
      expect(body.level).toBe('basic')
    })

    it('user with approved application can check status', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_user1' })
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user_1' })
      vi.mocked(prisma.kycApplication.findUnique).mockResolvedValue({
        status: 'approved',
        level: 'enhanced',
        rejectionReason: null,
      })

      const res = await GET(makeRequest())
      expect(res.status).toBe(200)
      const body = await res.json()

      expect(body.status).toBe('approved')
      expect(body.level).toBe('enhanced')
    })

    it('rejected user sees rejection reason', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_user1' })
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user_1' })
      const rejectionReason = 'Address verification failed'
      vi.mocked(prisma.kycApplication.findUnique).mockResolvedValue({
        status: 'rejected',
        level: 'basic',
        rejectionReason,
      })

      const res = await GET(makeRequest())
      expect(res.status).toBe(200)
      const body = await res.json()

      expect(body.status).toBe('rejected')
      expect(body.rejectionReason).toBe(rejectionReason)
    })
  })
})
