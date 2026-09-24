import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET, POST } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    anchorSession: {
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
  },
}))

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))

vi.mock('@/lib/sep24', () => ({
  initiateSep24Session: vi.fn(),
}))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { initiateSep24Session } from '@/lib/sep24'

const mockUser = { id: 'user-1', privyId: 'privy-1', email: 'user@example.com' }
const mockClaims = { userId: 'privy-1' }
const mockSep24Result = {
  jwtToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  interactiveUrl: 'https://moneygram.stellar.org/interactive?token=xyz',
}

function makeRequest(method: string = 'GET', body?: any): NextRequest {
  return new NextRequest('http://localhost/api/anchor-sessions', {
    method,
    headers: { authorization: 'Bearer token' },
    body: body ? JSON.stringify(body) : undefined,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
  vi.mocked(initiateSep24Session).mockResolvedValue(mockSep24Result)
})

// ─────────────────────────────────────────────────────────────────────────
// GET /api/anchor-sessions
// ─────────────────────────────────────────────────────────────────────────

describe('GET /api/anchor-sessions', () => {
  describe('happy path', () => {
    it('returns list of user sessions without jwtToken', async () => {
      const mockSessions = [
        {
          id: 'session-1',
          anchorId: 'moneygram',
          expiresAt: new Date(Date.now() + 60000), // 1 min from now
          createdAt: new Date(),
        },
        {
          id: 'session-2',
          anchorId: 'yellowcard',
          expiresAt: new Date(Date.now() + 120000), // 2 min from now
          createdAt: new Date(Date.now() - 60000), // 1 min ago
        },
      ]
      vi.mocked(prisma.anchorSession.findMany).mockResolvedValue(mockSessions as any)

      const res = await GET(makeRequest())
      expect(res.status).toBe(200)
      const data = await res.json()

      expect(data.sessions).toHaveLength(2)
      expect(data.sessions[0]).toMatchObject({
        id: 'session-1',
        anchorId: 'moneygram',
        computedStatus: 'active',
      })
      expect(data.sessions[0]).not.toHaveProperty('jwtToken')
      expect(data.sessions[1]).not.toHaveProperty('jwtToken')
    })

    it('returns active status for non-expired sessions', async () => {
      const mockSessions = [
        {
          id: 'session-1',
          anchorId: 'moneygram',
          expiresAt: new Date(Date.now() + 60000), // future
          createdAt: new Date(),
        },
      ]
      vi.mocked(prisma.anchorSession.findMany).mockResolvedValue(mockSessions as any)

      const res = await GET(makeRequest())
      const data = await res.json()

      expect(data.sessions[0].computedStatus).toBe('active')
    })

    it('returns expired status for past-expiry sessions', async () => {
      const mockSessions = [
        {
          id: 'session-1',
          anchorId: 'moneygram',
          expiresAt: new Date(Date.now() - 60000), // past
          createdAt: new Date(),
        },
      ]
      vi.mocked(prisma.anchorSession.findMany).mockResolvedValue(mockSessions as any)

      const res = await GET(makeRequest())
      const data = await res.json()

      expect(data.sessions[0].computedStatus).toBe('expired')
    })

    it('returns empty array when user has no sessions', async () => {
      vi.mocked(prisma.anchorSession.findMany).mockResolvedValue([])

      const res = await GET(makeRequest())
      expect(res.status).toBe(200)
      const data = await res.json()

      expect(data.sessions).toEqual([])
    })

    it('returns sessions ordered by createdAt descending', async () => {
      const now = new Date()
      const mockSessions = [
        {
          id: 'session-1',
          anchorId: 'moneygram',
          expiresAt: new Date(now.getTime() + 60000),
          createdAt: new Date(now.getTime() + 10000),
        },
        {
          id: 'session-2',
          anchorId: 'yellowcard',
          expiresAt: new Date(now.getTime() + 120000),
          createdAt: now,
        },
      ]
      vi.mocked(prisma.anchorSession.findMany).mockResolvedValue(mockSessions as any)

      const res = await GET(makeRequest())
      const data = await res.json()

      // Verify the mocked query was called with correct orderBy
      expect(vi.mocked(prisma.anchorSession.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { createdAt: 'desc' },
        })
      )
    })

    it('includes computed fields in response', async () => {
      const expiresAt = new Date(Date.now() + 60000)
      const createdAt = new Date()
      const mockSessions = [
        {
          id: 'session-1',
          anchorId: 'moneygram',
          expiresAt,
          createdAt,
        },
      ]
      vi.mocked(prisma.anchorSession.findMany).mockResolvedValue(mockSessions as any)

      const res = await GET(makeRequest())
      const data = await res.json()

      expect(data.sessions[0]).toHaveProperty('id')
      expect(data.sessions[0]).toHaveProperty('anchorId')
      expect(data.sessions[0]).toHaveProperty('computedStatus')
      expect(data.sessions[0]).toHaveProperty('expiresAt')
      expect(data.sessions[0]).toHaveProperty('createdAt')
    })
  })

  describe('authentication', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue(null as any)

      const res = await GET(makeRequest())
      expect(res.status).toBe(401)
      const data = await res.json()
      expect(data.error).toBe('Unauthorized')
    })

    it('returns 401 when authorization header missing', async () => {
      const req = new NextRequest('http://localhost/api/anchor-sessions', {
        method: 'GET',
      })
      const res = await GET(req)
      expect(res.status).toBe(401)
    })

    it('returns 404 when user not found after auth', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null)

      const res = await GET(makeRequest())
      expect(res.status).toBe(404)
      const data = await res.json()
      expect(data.error).toBe('Not Found')
    })
  })

  describe('security - jwtToken never returned', () => {
    it('does not include jwtToken key in response objects', async () => {
      const mockSessions = [
        {
          id: 'session-1',
          anchorId: 'moneygram',
          expiresAt: new Date(Date.now() + 60000),
          createdAt: new Date(),
        },
      ]
      vi.mocked(prisma.anchorSession.findMany).mockResolvedValue(mockSessions as any)

      const res = await GET(makeRequest())
      const data = await res.json()

      expect(JSON.stringify(data)).not.toContain('jwtToken')
      expect(JSON.stringify(data)).not.toContain('eyJ') // JWT header
    })

    it('queries with explicit select excluding jwtToken', async () => {
      vi.mocked(prisma.anchorSession.findMany).mockResolvedValue([])

      await GET(makeRequest())

      const callArgs = vi.mocked(prisma.anchorSession.findMany).mock.calls[0][0]
      expect(callArgs.select).toEqual({
        id: true,
        anchorId: true,
        expiresAt: true,
        createdAt: true,
      })
      expect(callArgs.select).not.toHaveProperty('jwtToken')
    })
  })

  describe('error handling', () => {
    it('returns 500 on prisma error', async () => {
      vi.mocked(prisma.anchorSession.findMany).mockRejectedValue(new Error('Database error'))

      const res = await GET(makeRequest())
      expect(res.status).toBe(500)
      const data = await res.json()
      expect(data.error).toBe('Internal Server Error')
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────
// POST /api/anchor-sessions
// ─────────────────────────────────────────────────────────────────────────

describe('POST /api/anchor-sessions', () => {
  describe('happy path - new session', () => {
    it('creates new session with valid anchorId', async () => {
      const mockNewSession = {
        id: 'session-1',
        anchorId: 'moneygram',
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      vi.mocked(prisma.anchorSession.upsert).mockResolvedValue(mockNewSession as any)

      const res = await POST(makeRequest('POST', { anchorId: 'moneygram' }))
      expect(res.status).toBe(201)
      const data = await res.json()

      expect(data).toHaveProperty('id')
      expect(data).toHaveProperty('anchorId', 'moneygram')
      expect(data).toHaveProperty('interactiveUrl')
      expect(data).toHaveProperty('expiresAt')
      expect(data).toHaveProperty('createdAt')
    })

    it('response includes interactiveUrl from SEP-24', async () => {
      const mockNewSession = {
        id: 'session-1',
        anchorId: 'yellowcard',
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      vi.mocked(prisma.anchorSession.upsert).mockResolvedValue(mockNewSession as any)

      const res = await POST(makeRequest('POST', { anchorId: 'yellowcard' }))
      const data = await res.json()

      expect(data.interactiveUrl).toBe(mockSep24Result.interactiveUrl)
    })

    it('response does NOT include jwtToken', async () => {
      const mockNewSession = {
        id: 'session-1',
        anchorId: 'moneygram',
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      vi.mocked(prisma.anchorSession.upsert).mockResolvedValue(mockNewSession as any)

      const res = await POST(makeRequest('POST', { anchorId: 'moneygram' }))
      const data = await res.json()

      expect(data).not.toHaveProperty('jwtToken')
      expect(JSON.stringify(data)).not.toContain('eyJ')
    })

    it('calls prisma upsert with correct userId and anchorId', async () => {
      vi.mocked(prisma.anchorSession.upsert).mockResolvedValue({
        id: 'session-1',
        anchorId: 'moneygram',
        expiresAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any)

      await POST(makeRequest('POST', { anchorId: 'moneygram' }))

      expect(vi.mocked(prisma.anchorSession.upsert)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId_anchorId: {
              userId: 'user-1',
              anchorId: 'moneygram',
            },
          },
        })
      )
    })

    it('sets expiresAt to approximately SESSION_EXPIRY_MINUTES from now', async () => {
      const beforeTime = Date.now()
      vi.mocked(prisma.anchorSession.upsert).mockResolvedValue({
        id: 'session-1',
        anchorId: 'moneygram',
        expiresAt: new Date(beforeTime + 30 * 60 * 1000),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any)

      await POST(makeRequest('POST', { anchorId: 'moneygram' }))

      const callArgs = vi.mocked(prisma.anchorSession.upsert).mock.calls[0][0]
      const expiresAt = (callArgs.create as any).expiresAt
      const expectedExpiry = beforeTime + 30 * 60 * 1000

      // Check it's within 5 seconds of expected
      expect(Math.abs(expiresAt.getTime() - expectedExpiry)).toBeLessThan(5000)
    })

    it('stores jwtToken in database (not returned)', async () => {
      vi.mocked(prisma.anchorSession.upsert).mockResolvedValue({
        id: 'session-1',
        anchorId: 'moneygram',
        expiresAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any)

      await POST(makeRequest('POST', { anchorId: 'moneygram' }))

      const callArgs = vi.mocked(prisma.anchorSession.upsert).mock.calls[0][0]
      expect((callArgs.create as any).jwtToken).toBe(mockSep24Result.jwtToken)
      expect((callArgs.update as any).jwtToken).toBe(mockSep24Result.jwtToken)
    })
  })

  describe('happy path - refresh session', () => {
    it('upserts existing session instead of failing', async () => {
      const mockUpdatedSession = {
        id: 'session-1',
        anchorId: 'moneygram',
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        createdAt: new Date(Date.now() - 60000),
        updatedAt: new Date(),
      }
      vi.mocked(prisma.anchorSession.upsert).mockResolvedValue(mockUpdatedSession as any)

      const res = await POST(makeRequest('POST', { anchorId: 'moneygram' }))
      expect(res.status).toBe(201)

      expect(vi.mocked(prisma.anchorSession.upsert)).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.any(Object),
        })
      )
    })

    it('updates jwtToken and expiresAt on refresh', async () => {
      vi.mocked(prisma.anchorSession.upsert).mockResolvedValue({
        id: 'session-1',
        anchorId: 'moneygram',
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any)

      await POST(makeRequest('POST', { anchorId: 'moneygram' }))

      const callArgs = vi.mocked(prisma.anchorSession.upsert).mock.calls[0][0]
      const updateObj = callArgs.update as any

      expect(updateObj.jwtToken).toBe(mockSep24Result.jwtToken)
      expect(updateObj.expiresAt).toBeDefined()
    })
  })

  describe('validation - anchorId', () => {
    it('returns 400 when anchorId is missing', async () => {
      const res = await POST(makeRequest('POST', {}))
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toBe('Bad Request')
      expect(data.message).toContain('anchorId is required')
    })

    it('returns 400 for unsupported anchorId', async () => {
      const res = await POST(makeRequest('POST', { anchorId: 'unknown-bank' }))
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toBe('Bad Request')
      expect(data.message).toContain('Unsupported anchor')
      expect(data.message).toContain('unknown-bank')
    })

    it('400 message includes list of supported anchors', async () => {
      const res = await POST(makeRequest('POST', { anchorId: 'invalid' }))
      const data = await res.json()
      expect(data.message).toContain('moneygram')
      expect(data.message).toContain('yellowcard')
    })

    it('accepts valid moneygram anchorId', async () => {
      vi.mocked(prisma.anchorSession.upsert).mockResolvedValue({
        id: 'session-1',
        anchorId: 'moneygram',
        expiresAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any)

      const res = await POST(makeRequest('POST', { anchorId: 'moneygram' }))
      expect(res.status).toBe(201)
    })

    it('accepts valid yellowcard anchorId', async () => {
      vi.mocked(prisma.anchorSession.upsert).mockResolvedValue({
        id: 'session-1',
        anchorId: 'yellowcard',
        expiresAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any)

      const res = await POST(makeRequest('POST', { anchorId: 'yellowcard' }))
      expect(res.status).toBe(201)
    })
  })

  describe('validation - JSON body', () => {
    it('returns 400 for invalid JSON body', async () => {
      const req = new NextRequest('http://localhost/api/anchor-sessions', {
        method: 'POST',
        headers: { authorization: 'Bearer token' },
        body: 'invalid json {',
      })

      const res = await POST(req)
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toBe('Bad Request')
      expect(data.message).toContain('Invalid JSON body')
    })
  })

  describe('authentication', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue(null as any)

      const res = await POST(makeRequest('POST', { anchorId: 'moneygram' }))
      expect(res.status).toBe(401)
      const data = await res.json()
      expect(data.error).toBe('Unauthorized')
    })

    it('returns 404 when user not found after auth', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null)

      const res = await POST(makeRequest('POST', { anchorId: 'moneygram' }))
      expect(res.status).toBe(404)
      const data = await res.json()
      expect(data.error).toBe('Not Found')
    })
  })

  describe('security - jwtToken never returned', () => {
    it('response does not contain jwtToken field', async () => {
      vi.mocked(prisma.anchorSession.upsert).mockResolvedValue({
        id: 'session-1',
        anchorId: 'moneygram',
        expiresAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any)

      const res = await POST(makeRequest('POST', { anchorId: 'moneygram' }))
      const data = await res.json()

      expect(data).not.toHaveProperty('jwtToken')
      expect(JSON.stringify(data)).not.toContain('eyJ')
    })

    it('prisma select explicitly excludes jwtToken', async () => {
      vi.mocked(prisma.anchorSession.upsert).mockResolvedValue({
        id: 'session-1',
        anchorId: 'moneygram',
        expiresAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any)

      await POST(makeRequest('POST', { anchorId: 'moneygram' }))

      const callArgs = vi.mocked(prisma.anchorSession.upsert).mock.calls[0][0]
      expect(callArgs.select).toEqual({
        id: true,
        anchorId: true,
        expiresAt: true,
        createdAt: true,
        updatedAt: true,
      })
      expect(callArgs.select).not.toHaveProperty('jwtToken')
    })

    it('jwtToken never appears in console.error calls', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.mocked(prisma.anchorSession.upsert).mockRejectedValue(new Error('DB error'))

      await POST(makeRequest('POST', { anchorId: 'moneygram' }))

      const errorCalls = consoleSpy.mock.calls
      const errorStrings = errorCalls.map((call) => String(call[1]))
      const combined = errorStrings.join(' ')

      expect(combined).not.toContain('eyJ')
      expect(combined).not.toContain(mockSep24Result.jwtToken)

      consoleSpy.mockRestore()
    })
  })

  describe('error handling', () => {
    it('returns 500 when SEP-24 initiation fails', async () => {
      vi.mocked(initiateSep24Session).mockRejectedValue(new Error('SEP-24 API error'))

      const res = await POST(makeRequest('POST', { anchorId: 'moneygram' }))
      expect(res.status).toBe(500)
      const data = await res.json()
      expect(data.error).toBe('Internal Server Error')
    })

    it('returns 500 when prisma upsert fails', async () => {
      vi.mocked(prisma.anchorSession.upsert).mockRejectedValue(
        new Error('Unique constraint failed')
      )

      const res = await POST(makeRequest('POST', { anchorId: 'moneygram' }))
      expect(res.status).toBe(500)
      const data = await res.json()
      expect(data.error).toBe('Internal Server Error')
    })

    it('500 error response has correct shape', async () => {
      vi.mocked(initiateSep24Session).mockRejectedValue(new Error('SEP-24 error'))

      const res = await POST(makeRequest('POST', { anchorId: 'moneygram' }))
      const data = await res.json()

      expect(data).toHaveProperty('error')
      expect(data).toHaveProperty('message')
      expect(typeof data.error).toBe('string')
      expect(typeof data.message).toBe('string')
    })
  })

  describe('environment variable - ANCHOR_SESSION_EXPIRY_MINUTES', () => {
    it('respects custom expiry when env var is set', async () => {
      const originalEnv = process.env.ANCHOR_SESSION_EXPIRY_MINUTES
      process.env.ANCHOR_SESSION_EXPIRY_MINUTES = '60'

      vi.mocked(prisma.anchorSession.upsert).mockResolvedValue({
        id: 'session-1',
        anchorId: 'moneygram',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any)

      const beforeTime = Date.now()
      await POST(makeRequest('POST', { anchorId: 'moneygram' }))

      const callArgs = vi.mocked(prisma.anchorSession.upsert).mock.calls[0][0]
      const expiresAt = (callArgs.create as any).expiresAt
      const expectedExpiry = beforeTime + 60 * 60 * 1000

      expect(Math.abs(expiresAt.getTime() - expectedExpiry)).toBeLessThan(5000)

      process.env.ANCHOR_SESSION_EXPIRY_MINUTES = originalEnv
    })

    it('defaults to 30 minutes when env var not set', async () => {
      const originalEnv = process.env.ANCHOR_SESSION_EXPIRY_MINUTES
      delete process.env.ANCHOR_SESSION_EXPIRY_MINUTES

      vi.mocked(prisma.anchorSession.upsert).mockResolvedValue({
        id: 'session-1',
        anchorId: 'moneygram',
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any)

      const beforeTime = Date.now()
      await POST(makeRequest('POST', { anchorId: 'moneygram' }))

      const callArgs = vi.mocked(prisma.anchorSession.upsert).mock.calls[0][0]
      const expiresAt = (callArgs.create as any).expiresAt
      const expectedExpiry = beforeTime + 30 * 60 * 1000

      expect(Math.abs(expiresAt.getTime() - expectedExpiry)).toBeLessThan(5000)

      if (originalEnv !== undefined) process.env.ANCHOR_SESSION_EXPIRY_MINUTES = originalEnv
    })
  })
})
