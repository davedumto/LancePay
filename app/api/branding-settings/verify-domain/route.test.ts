import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    brandingSettings: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}))
vi.mock('dns', () => ({
  promises: {
    resolveTxt: vi.fn(),
  },
}))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { promises as dns } from 'dns'

const mockUser = { id: 'user-1' }
const mockClaims = { userId: 'privy-1' }

function makeRequest(body?: unknown, authToken?: string): NextRequest {
  return new NextRequest('http://localhost/api/branding-settings/verify-domain', {
    method: 'POST',
    headers: authToken ? { authorization: `Bearer ${authToken}` } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
})

describe('POST /api/branding-settings/verify-domain', () => {
  describe('Authentication', () => {
    it('returns 401 when no authorization header is present', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue(null)
      const res = await POST(makeRequest({ domain: 'example.com' }))
      expect(res.status).toBe(401)
      const data = await res.json()
      expect(data.error).toBe('Unauthorized')
    })

    it('returns 401 when authorization token is invalid', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue(null)
      const res = await POST(makeRequest({ domain: 'example.com' }, 'invalid-token'))
      expect(res.status).toBe(401)
      const data = await res.json()
      expect(data.error).toBe('Unauthorized')
    })
  })

  describe('Input Validation', () => {
    it('returns 400 with invalid JSON body', async () => {
      const req = new NextRequest('http://localhost/api/branding-settings/verify-domain', {
        method: 'POST',
        headers: { authorization: 'Bearer token' },
        body: 'not-json',
      })
      const res = await POST(req)
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toBe('Invalid JSON body')
    })

    it('returns 400 when domain is missing', async () => {
      const res = await POST(makeRequest({}))
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toBe('Invalid domain format')
    })

    it('returns 400 when domain is empty string', async () => {
      const res = await POST(makeRequest({ domain: '' }))
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toBe('Invalid domain format')
    })

    it('returns 400 when domain is invalid format', async () => {
      const invalidDomains = [
        'not-a-domain',
        'example',
        'example.',
        '.example.com',
        'example..com',
        'example-.com',
        '-example.com',
      ]

      for (const domain of invalidDomains) {
        const res = await POST(makeRequest({ domain }))
        expect(res.status).toBe(400, `Failed for domain: ${domain}`)
        const data = await res.json()
        expect(data.error).toBe('Invalid domain format')
      }
    })

    it('accepts valid domain formats', async () => {
      const validDomains = [
        'example.com',
        'subdomain.example.com',
        'invoices.acme.co.uk',
        'a.b.c.d.example.com',
      ]

      vi.mocked(prisma.brandingSettings.create).mockResolvedValue({
        id: 'bs-1',
        userId: 'user-1',
        customDomain: 'example.com',
        verificationToken: 'abc123',
        verificationStatus: 'pending',
        verifiedAt: null,
        verificationAttempts: 1,
        logoUrl: null,
        primaryColor: '#000000',
        footerText: null,
        signatureUrl: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any)

      vi.mocked(dns.resolveTxt).mockResolvedValue([])

      for (const domain of validDomains) {
        vi.clearAllMocks()
        vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
        vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
        vi.mocked(prisma.brandingSettings.create).mockResolvedValue({
          id: 'bs-1',
          userId: 'user-1',
          customDomain: domain,
          verificationToken: 'abc123',
          verificationStatus: 'pending',
          verifiedAt: null,
          verificationAttempts: 1,
          logoUrl: null,
          primaryColor: '#000000',
          footerText: null,
          signatureUrl: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as any)

        const res = await POST(makeRequest({ domain }))
        expect([200, 201]).toContain(res.status)
      }
    })
  })

  describe('DNS Verification - Happy Path', () => {
    it('marks domain as verified when DNS TXT record contains correct token', async () => {
      const token = 'abc123def456'
      const domain = 'example.com'

      vi.mocked(prisma.brandingSettings.findUnique).mockResolvedValue(null)
      vi.mocked(prisma.brandingSettings.create).mockResolvedValue({
        id: 'bs-1',
        userId: 'user-1',
        customDomain: domain,
        verificationToken: token,
        verificationStatus: 'pending',
        verifiedAt: null,
        verificationAttempts: 0,
        logoUrl: null,
        primaryColor: '#000000',
        footerText: null,
        signatureUrl: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any)

      // Mock DNS returning the verification token
      vi.mocked(dns.resolveTxt).mockResolvedValue([
        ['lancepay-verify=' + token],
      ] as any)

      vi.mocked(prisma.brandingSettings.update).mockResolvedValue({
        id: 'bs-1',
        customDomain: domain,
        verificationStatus: 'verified',
        verifiedAt: new Date(),
      } as any)

      const res = await POST(makeRequest({ domain }))
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.status).toBe('verified')
      expect(data.domain).toBe(domain)
      expect(data.verifiedAt).toBeDefined()
      expect(data.message).toBe('Domain successfully verified')

      expect(prisma.brandingSettings.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            verificationStatus: 'verified',
            verifiedAt: expect.any(Date),
            verificationAttempts: 1,
          }),
        }),
      )

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ domain }),
        'Domain verification successful',
      )
    })

    it('handles TXT records as arrays correctly', async () => {
      const token = 'token123'
      const domain = 'example.com'

      vi.mocked(prisma.brandingSettings.findUnique).mockResolvedValue(null)
      vi.mocked(prisma.brandingSettings.create).mockResolvedValue({
        id: 'bs-1',
        userId: 'user-1',
        customDomain: domain,
        verificationToken: token,
        verificationStatus: 'pending',
        verifiedAt: null,
        verificationAttempts: 0,
        logoUrl: null,
        primaryColor: '#000000',
        footerText: null,
        signatureUrl: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any)

      // DNS TXT records return arrays (common in some DNS libraries)
      vi.mocked(dns.resolveTxt).mockResolvedValue([
        ['v=spf1 include:example.com ~all'],
        ['lancepay-verify=', token], // split across array elements
      ] as any)

      vi.mocked(prisma.brandingSettings.update).mockResolvedValue({
        id: 'bs-1',
        customDomain: domain,
        verificationStatus: 'verified',
        verifiedAt: new Date(),
      } as any)

      const res = await POST(makeRequest({ domain }))
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.status).toBe('verified')
    })
  })

  describe('DNS Verification - Pending State', () => {
    it('returns pending status when DNS lookup succeeds but token not found', async () => {
      const token = 'abc123'
      const domain = 'example.com'

      vi.mocked(prisma.brandingSettings.findUnique).mockResolvedValue(null)
      vi.mocked(prisma.brandingSettings.create).mockResolvedValue({
        id: 'bs-1',
        userId: 'user-1',
        customDomain: domain,
        verificationToken: token,
        verificationStatus: 'pending',
        verifiedAt: null,
        verificationAttempts: 0,
        logoUrl: null,
        primaryColor: '#000000',
        footerText: null,
        signatureUrl: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any)

      // DNS resolves but no verification token
      vi.mocked(dns.resolveTxt).mockResolvedValue([
        ['v=spf1 include:example.com ~all'],
        ['other-record=value'],
      ] as any)

      vi.mocked(prisma.brandingSettings.update).mockResolvedValue({
        id: 'bs-1',
        customDomain: domain,
        verificationStatus: 'pending',
        verificationToken: token,
        verificationAttempts: 1,
      } as any)

      const res = await POST(makeRequest({ domain }))
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.status).toBe('pending')
      expect(data.verificationCode).toBe(token)
      expect(data.instructionFormat).toBe(`lancepay-verify=${token}`)
      expect(data.message).toContain('Please add the following TXT record')
      expect(data.attempts).toBe(1)

      // Should NOT be marked verified
      expect(prisma.brandingSettings.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.not.objectContaining({
            verificationStatus: 'verified',
            verifiedAt: expect.any(Date),
          }),
        }),
      )
    })

    it('does not mark domain verified when DNS lookup fails (ENOTFOUND)', async () => {
      const token = 'abc123'
      const domain = 'nonexistent-domain-that-does-not-exist.com'

      vi.mocked(prisma.brandingSettings.findUnique).mockResolvedValue(null)
      vi.mocked(prisma.brandingSettings.create).mockResolvedValue({
        id: 'bs-1',
        userId: 'user-1',
        customDomain: domain,
        verificationToken: token,
        verificationStatus: 'pending',
        verifiedAt: null,
        verificationAttempts: 0,
        logoUrl: null,
        primaryColor: '#000000',
        footerText: null,
        signatureUrl: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any)

      // DNS lookup throws error
      vi.mocked(dns.resolveTxt).mockRejectedValue(new Error('ENOTFOUND: nonexistent domain'))

      vi.mocked(prisma.brandingSettings.update).mockResolvedValue({
        id: 'bs-1',
        customDomain: domain,
        verificationStatus: 'pending',
        verificationToken: token,
        verificationAttempts: 1,
      } as any)

      const res = await POST(makeRequest({ domain }))
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.status).toBe('pending')
      expect(data.domain).toBe(domain)
      // Should NOT be marked verified
      expect(prisma.brandingSettings.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            verificationStatus: 'verified',
          }),
        }),
      )
    })

    it('returns pending on DNS timeout gracefully', async () => {
      const token = 'abc123'
      const domain = 'example.com'

      vi.mocked(prisma.brandingSettings.findUnique).mockResolvedValue(null)
      vi.mocked(prisma.brandingSettings.create).mockResolvedValue({
        id: 'bs-1',
        userId: 'user-1',
        customDomain: domain,
        verificationToken: token,
        verificationStatus: 'pending',
        verifiedAt: null,
        verificationAttempts: 0,
        logoUrl: null,
        primaryColor: '#000000',
        footerText: null,
        signatureUrl: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any)

      // DNS lookup times out
      const timeoutError = new Error('ETIMEOUT: DNS request timeout')
      vi.mocked(dns.resolveTxt).mockRejectedValue(timeoutError)

      vi.mocked(prisma.brandingSettings.update).mockResolvedValue({
        id: 'bs-1',
        customDomain: domain,
        verificationStatus: 'pending',
        verificationToken: token,
        verificationAttempts: 1,
      } as any)

      const res = await POST(makeRequest({ domain }))
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.status).toBe('pending')
    })
  })

  describe('Token Generation and Storage', () => {
    it('generates a unique token on first verification attempt', async () => {
      const domain = 'example.com'

      vi.mocked(prisma.brandingSettings.findUnique).mockResolvedValue(null)

      const createSpy = vi.mocked(prisma.brandingSettings.create)
      createSpy.mockResolvedValue({
        id: 'bs-1',
        userId: 'user-1',
        customDomain: domain,
        verificationToken: 'generated-token-123',
        verificationStatus: 'pending',
        verifiedAt: null,
        verificationAttempts: 0,
        logoUrl: null,
        primaryColor: '#000000',
        footerText: null,
        signatureUrl: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any)

      vi.mocked(dns.resolveTxt).mockResolvedValue([])

      vi.mocked(prisma.brandingSettings.update).mockResolvedValue({
        id: 'bs-1',
        customDomain: domain,
        verificationStatus: 'pending',
        verificationToken: 'generated-token-123',
        verificationAttempts: 1,
      } as any)

      const res = await POST(makeRequest({ domain }))
      expect(res.status).toBe(200)

      // Verify that a token was generated and stored
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            customDomain: domain,
            verificationToken: expect.any(String),
            verificationStatus: 'pending',
          }),
        }),
      )
    })

    it('reuses existing token on subsequent verification attempts', async () => {
      const domain = 'example.com'
      const existingToken = 'existing-token-123'

      const existingSettings = {
        id: 'bs-1',
        userId: 'user-1',
        customDomain: domain,
        verificationToken: existingToken,
        verificationStatus: 'pending',
        verifiedAt: null,
        verificationAttempts: 2,
        logoUrl: null,
        primaryColor: '#000000',
        footerText: null,
        signatureUrl: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }

      vi.mocked(prisma.brandingSettings.findUnique).mockResolvedValue(existingSettings as any)
      vi.mocked(dns.resolveTxt).mockResolvedValue([])
      vi.mocked(prisma.brandingSettings.update).mockResolvedValue({
        id: 'bs-1',
        customDomain: domain,
        verificationStatus: 'pending',
        verificationToken: existingToken,
        verificationAttempts: 3,
      } as any)

      const res = await POST(makeRequest({ domain }))
      expect(res.status).toBe(200)
      const data = await res.json()

      // Should return the same token
      expect(data.verificationCode).toBe(existingToken)

      // Should NOT have called create (only update)
      expect(prisma.brandingSettings.create).not.toHaveBeenCalled()
    })
  })

  describe('Attempt Limiting', () => {
    it('returns 429 when max verification attempts exceeded', async () => {
      const domain = 'example.com'
      const token = 'abc123'

      vi.mocked(prisma.brandingSettings.findUnique).mockResolvedValue({
        id: 'bs-1',
        userId: 'user-1',
        customDomain: domain,
        verificationToken: token,
        verificationStatus: 'pending',
        verifiedAt: null,
        verificationAttempts: 10, // Already at max
        logoUrl: null,
        primaryColor: '#000000',
        footerText: null,
        signatureUrl: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any)

      const res = await POST(makeRequest({ domain }))
      expect(res.status).toBe(429)
      const data = await res.json()
      expect(data.error).toContain('Verification attempts exceeded')
    })

    it('increments attempt counter on each call', async () => {
      const domain = 'example.com'
      const token = 'abc123'

      vi.mocked(prisma.brandingSettings.findUnique).mockResolvedValue({
        id: 'bs-1',
        userId: 'user-1',
        customDomain: domain,
        verificationToken: token,
        verificationStatus: 'pending',
        verifiedAt: null,
        verificationAttempts: 2,
        logoUrl: null,
        primaryColor: '#000000',
        footerText: null,
        signatureUrl: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any)

      vi.mocked(dns.resolveTxt).mockResolvedValue([])

      vi.mocked(prisma.brandingSettings.update).mockResolvedValue({
        id: 'bs-1',
        customDomain: domain,
        verificationStatus: 'pending',
        verificationToken: token,
        verificationAttempts: 3,
      } as any)

      const res = await POST(makeRequest({ domain }))
      expect(res.status).toBe(200)

      expect(prisma.brandingSettings.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            verificationAttempts: 3,
          }),
        }),
      )
    })
  })

  describe('Multi-Domain Handling', () => {
    it('returns 409 when user tries to verify a different domain', async () => {
      const existingDomain = 'existing.com'
      const newDomain = 'different.com'

      vi.mocked(prisma.brandingSettings.findUnique).mockResolvedValue({
        id: 'bs-1',
        userId: 'user-1',
        customDomain: existingDomain,
        verificationToken: 'token123',
        verificationStatus: 'verified',
        verifiedAt: new Date(),
        verificationAttempts: 1,
        logoUrl: null,
        primaryColor: '#000000',
        footerText: null,
        signatureUrl: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any)

      const res = await POST(makeRequest({ domain: newDomain }))
      expect(res.status).toBe(409)
      const data = await res.json()
      expect(data.error).toContain('Cannot verify different domain')
    })

    it('allows re-verification of the same domain', async () => {
      const domain = 'example.com'
      const token = 'token123'

      vi.mocked(prisma.brandingSettings.findUnique).mockResolvedValue({
        id: 'bs-1',
        userId: 'user-1',
        customDomain: domain,
        verificationToken: token,
        verificationStatus: 'pending',
        verifiedAt: null,
        verificationAttempts: 1,
        logoUrl: null,
        primaryColor: '#000000',
        footerText: null,
        signatureUrl: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any)

      vi.mocked(dns.resolveTxt).mockResolvedValue([
        ['lancepay-verify=' + token],
      ] as any)

      vi.mocked(prisma.brandingSettings.update).mockResolvedValue({
        id: 'bs-1',
        customDomain: domain,
        verificationStatus: 'verified',
        verifiedAt: new Date(),
      } as any)

      const res = await POST(makeRequest({ domain }))
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.status).toBe('verified')
    })
  })

  describe('Idempotency', () => {
    it('does not re-break already verified domain on repeat call', async () => {
      const domain = 'example.com'
      const token = 'token123'

      vi.mocked(prisma.brandingSettings.findUnique).mockResolvedValue({
        id: 'bs-1',
        userId: 'user-1',
        customDomain: domain,
        verificationToken: token,
        verificationStatus: 'verified',
        verifiedAt: new Date('2026-09-25T00:00:00Z'),
        verificationAttempts: 1,
        logoUrl: null,
        primaryColor: '#000000',
        footerText: null,
        signatureUrl: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any)

      // DNS check still passes
      vi.mocked(dns.resolveTxt).mockResolvedValue([
        ['lancepay-verify=' + token],
      ] as any)

      vi.mocked(prisma.brandingSettings.update).mockResolvedValue({
        id: 'bs-1',
        customDomain: domain,
        verificationStatus: 'verified',
        verifiedAt: new Date('2026-09-25T00:00:00Z'),
      } as any)

      const res = await POST(makeRequest({ domain }))
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.status).toBe('verified')
    })
  })

  describe('Error Handling', () => {
    it('returns 500 on unexpected database error', async () => {
      vi.mocked(prisma.brandingSettings.findUnique).mockRejectedValue(
        new Error('Database connection error'),
      )

      const res = await POST(makeRequest({ domain: 'example.com' }))
      expect(res.status).toBe(500)
      const data = await res.json()
      expect(data.error).toBe('Failed to verify domain')

      expect(logger.error).toHaveBeenCalled()
    })

    it('returns 500 on Prisma create error', async () => {
      vi.mocked(prisma.brandingSettings.findUnique).mockResolvedValue(null)
      vi.mocked(prisma.brandingSettings.create).mockRejectedValue(
        new Error('Unique constraint failed'),
      )

      const res = await POST(makeRequest({ domain: 'example.com' }))
      expect(res.status).toBe(500)
      const data = await res.json()
      expect(data.error).toBe('Failed to verify domain')
    })
  })
})
