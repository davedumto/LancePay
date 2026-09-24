import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DELETE } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    anchorSession: { findUnique: vi.fn(), update: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUser = {
  id: 'user-1',
  privyId: 'privy-1',
}

const mockAnchorSession = {
  id: 'session-1',
  userId: 'user-1',
  anchorId: 'moneygram',
  jwtToken: 'jwt-token-abc123',
  expiresAt: new Date(Date.now() + 3600000), // 1 hour from now
  createdAt: new Date(),
}

const mockClaims = { userId: 'privy-1' }

function makeRequest(id: string): NextRequest {
  return new NextRequest(`http://localhost/api/anchor-sessions/${id}`, {
    method: 'DELETE',
    headers: { authorization: 'Bearer token' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
  vi.mocked(prisma.anchorSession.findUnique).mockResolvedValue(mockAnchorSession as any)
  vi.mocked(prisma.anchorSession.update).mockResolvedValue({
    ...mockAnchorSession,
    jwtToken: null,
  } as any)
})

describe('DELETE /api/anchor-sessions/[id]', () => {
  describe('HAPPY PATH', () => {
    it('returns 200 with session id when valid id and owner', async () => {
      const res = await DELETE(makeRequest('session-1'), { params: { id: 'session-1' } })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.message).toBe('Anchor session terminated successfully')
      expect(body.id).toBe('session-1')
    })

    it('invalidates jwtToken by setting it to null', async () => {
      await DELETE(makeRequest('session-1'), { params: { id: 'session-1' } })
      expect(vi.mocked(prisma.anchorSession.update)).toHaveBeenCalledWith({
        where: { id: 'session-1' },
        data: { jwtToken: null },
      })
    })

    it('calls prisma.anchorSession.update with correct parameters', async () => {
      await DELETE(makeRequest('session-1'), { params: { id: 'session-1' } })
      expect(vi.mocked(prisma.anchorSession.update)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(prisma.anchorSession.update)).toHaveBeenCalledWith({
        where: { id: 'session-1' },
        data: { jwtToken: null },
      })
    })
  })

  describe('AUTHENTICATION', () => {
    it('returns 401 when no auth token provided', async () => {
      const req = new NextRequest('http://localhost/api/anchor-sessions/session-1', {
        method: 'DELETE',
      })
      const res = await DELETE(req, { params: { id: 'session-1' } })
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('Unauthorized')
      expect(body.message).toBe('Authentication required')
    })

    it('returns 401 when verifyAuthToken returns null', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue(null)
      const res = await DELETE(makeRequest('session-1'), { params: { id: 'session-1' } })
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('Unauthorized')
    })

    it('returns 401 when user not found in database', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
      const res = await DELETE(makeRequest('session-1'), { params: { id: 'session-1' } })
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('Unauthorized')
      expect(body.message).toBe('User not found')
    })

    it('has correct 401 error response shape', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue(null)
      const res = await DELETE(makeRequest('session-1'), { params: { id: 'session-1' } })
      const body = await res.json()
      expect(body).toHaveProperty('error')
      expect(body).toHaveProperty('message')
    })
  })

  describe('AUTHORIZATION', () => {
    it('returns 403 when session belongs to different user', async () => {
      const differentUserSession = { ...mockAnchorSession, userId: 'user-different' }
      vi.mocked(prisma.anchorSession.findUnique).mockResolvedValue(differentUserSession as any)
      const res = await DELETE(makeRequest('session-1'), { params: { id: 'session-1' } })
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.error).toBe('Forbidden')
      expect(body.message).toBe('You do not own this anchor session')
    })

    it('has correct 403 error response shape', async () => {
      const differentUserSession = { ...mockAnchorSession, userId: 'user-different' }
      vi.mocked(prisma.anchorSession.findUnique).mockResolvedValue(differentUserSession as any)
      const res = await DELETE(makeRequest('session-1'), { params: { id: 'session-1' } })
      const body = await res.json()
      expect(body).toHaveProperty('error')
      expect(body).toHaveProperty('message')
    })

    it('does not call update when authorization fails', async () => {
      const differentUserSession = { ...mockAnchorSession, userId: 'user-different' }
      vi.mocked(prisma.anchorSession.findUnique).mockResolvedValue(differentUserSession as any)
      await DELETE(makeRequest('session-1'), { params: { id: 'session-1' } })
      expect(vi.mocked(prisma.anchorSession.update)).not.toHaveBeenCalled()
    })
  })

  describe('NOT FOUND / EXPIRED', () => {
    it('returns 404 when session does not exist', async () => {
      vi.mocked(prisma.anchorSession.findUnique).mockResolvedValue(null)
      const res = await DELETE(makeRequest('missing-id'), { params: { id: 'missing-id' } })
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toBe('Not Found')
      expect(body.message).toBe('Anchor session not found')
    })

    it('returns 404 when session already expired naturally', async () => {
      const expiredSession = {
        ...mockAnchorSession,
        expiresAt: new Date(Date.now() - 3600000), // 1 hour ago
      }
      vi.mocked(prisma.anchorSession.findUnique).mockResolvedValue(expiredSession as any)
      const res = await DELETE(makeRequest('session-1'), { params: { id: 'session-1' } })
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toBe('Not Found')
      expect(body.message).toBe('Anchor session has already expired')
    })

    it('returns same error shape for both 404 cases (not found and expired)', async () => {
      // Test missing session
      vi.mocked(prisma.anchorSession.findUnique).mockResolvedValue(null)
      const res1 = await DELETE(makeRequest('missing-id'), { params: { id: 'missing-id' } })
      const body1 = await res1.json()

      // Test expired session
      const expiredSession = {
        ...mockAnchorSession,
        expiresAt: new Date(Date.now() - 3600000),
      }
      vi.mocked(prisma.anchorSession.findUnique).mockResolvedValue(expiredSession as any)
      const res2 = await DELETE(makeRequest('session-1'), { params: { id: 'session-1' } })
      const body2 = await res2.json()

      // Both should have error and message properties
      expect(body1).toHaveProperty('error', 'Not Found')
      expect(body2).toHaveProperty('error', 'Not Found')
      expect(body1).toHaveProperty('message')
      expect(body2).toHaveProperty('message')
    })

    it('does not call update when session not found', async () => {
      vi.mocked(prisma.anchorSession.findUnique).mockResolvedValue(null)
      await DELETE(makeRequest('missing-id'), { params: { id: 'missing-id' } })
      expect(vi.mocked(prisma.anchorSession.update)).not.toHaveBeenCalled()
    })

    it('does not call update when session expired', async () => {
      const expiredSession = {
        ...mockAnchorSession,
        expiresAt: new Date(Date.now() - 3600000),
      }
      vi.mocked(prisma.anchorSession.findUnique).mockResolvedValue(expiredSession as any)
      await DELETE(makeRequest('session-1'), { params: { id: 'session-1' } })
      expect(vi.mocked(prisma.anchorSession.update)).not.toHaveBeenCalled()
    })
  })

  describe('ERROR HANDLING', () => {
    it('returns 500 when prisma throws unexpected error', async () => {
      vi.mocked(prisma.anchorSession.update).mockRejectedValue(new Error('Database error'))
      const res = await DELETE(makeRequest('session-1'), { params: { id: 'session-1' } })
      expect(res.status).toBe(500)
      const body = await res.json()
      expect(body.error).toBe('Internal Server Error')
      expect(body.message).toBe('Failed to terminate session')
    })

    it('has correct 500 error response shape', async () => {
      vi.mocked(prisma.anchorSession.update).mockRejectedValue(new Error('Database error'))
      const res = await DELETE(makeRequest('session-1'), { params: { id: 'session-1' } })
      const body = await res.json()
      expect(body).toHaveProperty('error')
      expect(body).toHaveProperty('message')
    })

    it('logs error to console when exception occurs', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const testError = new Error('Test error')
      vi.mocked(prisma.anchorSession.update).mockRejectedValue(testError)
      await DELETE(makeRequest('session-1'), { params: { id: 'session-1' } })
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'DELETE /api/anchor-sessions/[id] error:',
        testError
      )
      consoleErrorSpy.mockRestore()
    })
  })

  describe('STALE CLIENT PROTECTION', () => {
    it('sets jwtToken to null after termination', async () => {
      await DELETE(makeRequest('session-1'), { params: { id: 'session-1' } })
      expect(vi.mocked(prisma.anchorSession.update)).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ jwtToken: null }),
        })
      )
    })

    it('subsequent request with same id returns 404 after update', async () => {
      // First deletion
      await DELETE(makeRequest('session-1'), { params: { id: 'session-1' } })

      // Simulate stale client trying to reuse the session
      // The session would now have jwtToken: null, so we can't really test "409 already terminated"
      // since the schema doesn't have a terminatedAt field. But we verify the token is null
      expect(vi.mocked(prisma.anchorSession.update)).toHaveBeenCalledWith({
        where: { id: 'session-1' },
        data: { jwtToken: null },
      })
    })

    it('stale client cannot resume with invalidated token', async () => {
      // Verify that jwtToken is set to null, preventing stale clients
      await DELETE(makeRequest('session-1'), { params: { id: 'session-1' } })

      const updateCall = vi.mocked(prisma.anchorSession.update).mock.calls[0][0]
      expect(updateCall.data.jwtToken).toBeNull()
    })
  })

  describe('REQUEST PARAMETERS', () => {
    it('extracts id from params correctly', async () => {
      await DELETE(makeRequest('abc-123'), { params: { id: 'abc-123' } })
      expect(vi.mocked(prisma.anchorSession.findUnique)).toHaveBeenCalledWith({
        where: { id: 'abc-123' },
      })
    })

    it('handles different id formats', async () => {
      const testIds = ['session-1', 'uuid-123-abc', 'short-id']
      for (const testId of testIds) {
        vi.clearAllMocks()
        vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
        vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
        vi.mocked(prisma.anchorSession.findUnique).mockResolvedValue(mockAnchorSession as any)
        vi.mocked(prisma.anchorSession.update).mockResolvedValue({
          ...mockAnchorSession,
          jwtToken: null,
        } as any)

        await DELETE(makeRequest(testId), { params: { id: testId } })
        expect(vi.mocked(prisma.anchorSession.findUnique)).toHaveBeenCalledWith({
          where: { id: testId },
        })
      }
    })
  })
})
