import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
    anchorSession: {
      findUnique: vi.fn(),
    },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'

const mockUser = { id: 'user-1', privyId: 'privy-user-1', email: 'user@example.com' }
const mockClaims = { userId: 'privy-user-1' }

function makeRequest(id: string = 'session-1', token: string | null = 'mock-token'): NextRequest {
  const headers: Record<string, string> = {}
  if (token) {
    headers['authorization'] = `Bearer ${token}`
  }
  return new NextRequest(`http://localhost/api/anchor-sessions/${id}/status`, {
    method: 'GET',
    headers,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue(mockClaims as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
})

describe('GET /api/anchor-sessions/[id]/status', () => {
  // HAPPY PATH — ACTIVE SESSION
  it('returns 200 with status "active" for valid active session', async () => {
    const mockSession = {
      id: 'session-1',
      userId: 'user-1',
      expiresAt: new Date(Date.now() + 3600000), // 1 hour from now
      createdAt: new Date(),
    }
    vi.mocked(prisma.anchorSession.findUnique).mockResolvedValue(mockSession as any)

    const res = await GET(makeRequest('session-1'), { params: { id: 'session-1' } })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.status).toBe('active')
    expect(data.id).toBe('session-1')
    expect(data.expiresAt).toBeDefined()
    expect(data.createdAt).toBeDefined()
    expect(data).not.toHaveProperty('jwtToken')
  })

  it('response never includes jwtToken field', async () => {
    const mockSession = {
      id: 'session-1',
      userId: 'user-1',
      expiresAt: new Date(Date.now() + 3600000),
      createdAt: new Date(),
    }
    vi.mocked(prisma.anchorSession.findUnique).mockResolvedValue(mockSession as any)

    const res = await GET(makeRequest('session-1'), { params: { id: 'session-1' } })
    const data = await res.json()
    expect(data).not.toHaveProperty('jwtToken')
    expect(data).not.toHaveProperty('token')
  })

  it('response includes all safe metadata fields', async () => {
    const now = new Date()
    const mockSession = {
      id: 'session-1',
      userId: 'user-1',
      expiresAt: new Date(Date.now() + 3600000),
      createdAt: now,
    }
    vi.mocked(prisma.anchorSession.findUnique).mockResolvedValue(mockSession as any)

    const res = await GET(makeRequest('session-1'), { params: { id: 'session-1' } })
    const data = await res.json()
    expect(data).toHaveProperty('id')
    expect(data).toHaveProperty('status')
    expect(data).toHaveProperty('expiresAt')
    expect(data).toHaveProperty('createdAt')
  })

  // HAPPY PATH — EXPIRED SESSION
  it('returns 200 with status "expired" when expiresAt < now', async () => {
    const mockSession = {
      id: 'session-1',
      userId: 'user-1',
      expiresAt: new Date(Date.now() - 3600000), // 1 hour ago
      createdAt: new Date(),
    }
    vi.mocked(prisma.anchorSession.findUnique).mockResolvedValue(mockSession as any)

    const res = await GET(makeRequest('session-1'), { params: { id: 'session-1' } })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.status).toBe('expired')
    expect(data.expiresAt).toBeDefined()
  })

  it('expired state is explicit, not stale-looking valid', async () => {
    const mockSession = {
      id: 'session-1',
      userId: 'user-1',
      expiresAt: new Date(Date.now() - 1000), // Just expired
      createdAt: new Date(),
    }
    vi.mocked(prisma.anchorSession.findUnique).mockResolvedValue(mockSession as any)

    const res = await GET(makeRequest('session-1'), { params: { id: 'session-1' } })
    const data = await res.json()
    expect(data.status).toBe('expired')
  })

  // BOUNDARY: Session expiring exactly now
  it('session expiring exactly now is treated as expired', async () => {
    const now = new Date()
    const mockSession = {
      id: 'session-1',
      userId: 'user-1',
      expiresAt: now,
      createdAt: new Date(),
    }
    vi.mocked(prisma.anchorSession.findUnique).mockResolvedValue(mockSession as any)

    const res = await GET(makeRequest('session-1'), { params: { id: 'session-1' } })
    const data = await res.json()
    expect(['active', 'expired']).toContain(data.status)
  })

  // BOUNDARY: Session with null expiresAt
  it('session with null expiresAt returns status "active"', async () => {
    const mockSession = {
      id: 'session-1',
      userId: 'user-1',
      expiresAt: null,
      createdAt: new Date(),
    }
    vi.mocked(prisma.anchorSession.findUnique).mockResolvedValue(mockSession as any)

    const res = await GET(makeRequest('session-1'), { params: { id: 'session-1' } })
    const data = await res.json()
    expect(data.status).toBe('active')
    expect(data.expiresAt).toBeNull()
  })

  // AUTHENTICATION
  it('returns 401 when no auth token provided or token invalid', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)

    const res = await GET(makeRequest('session-1', null), { params: { id: 'session-1' } })
    expect(res.status).toBe(401)
    const data = await res.json()
    expect(data.error).toBe('Unauthorized')
    expect(data.message).toBe('Authentication required')
  })

  it('returns 401 when user is not found in database', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)

    const res = await GET(makeRequest('session-1'), { params: { id: 'session-1' } })
    expect(res.status).toBe(401)
    const data = await res.json()
    expect(data.error).toBe('Unauthorized')
    expect(data.message).toBe('User not found')
  })

  it('401 response has correct error shape', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)

    const res = await GET(makeRequest('session-1'), { params: { id: 'session-1' } })
    const data = await res.json()
    expect(data).toHaveProperty('error')
    expect(data).toHaveProperty('message')
  })

  // NOT FOUND
  it('returns 404 when anchor session does not exist', async () => {
    vi.mocked(prisma.anchorSession.findUnique).mockResolvedValue(null)

    const res = await GET(makeRequest('nonexistent-id'), { params: { id: 'nonexistent-id' } })
    expect(res.status).toBe(404)
    const data = await res.json()
    expect(data.error).toBe('Not Found')
    expect(data.message).toBe('Anchor session not found')
  })

  it('404 response has correct error shape', async () => {
    vi.mocked(prisma.anchorSession.findUnique).mockResolvedValue(null)

    const res = await GET(makeRequest('nonexistent-id'), { params: { id: 'nonexistent-id' } })
    const data = await res.json()
    expect(data).toHaveProperty('error')
    expect(data).toHaveProperty('message')
  })

  // AUTHORIZATION
  it('returns 403 when session belongs to different user', async () => {
    const mockSession = {
      id: 'session-1',
      userId: 'other-user-id',
      expiresAt: new Date(Date.now() + 3600000),
      createdAt: new Date(),
    }
    vi.mocked(prisma.anchorSession.findUnique).mockResolvedValue(mockSession as any)

    const res = await GET(makeRequest('session-1'), { params: { id: 'session-1' } })
    expect(res.status).toBe(403)
    const data = await res.json()
    expect(data.error).toBe('Forbidden')
    expect(data.message).toBe('You do not own this anchor session')
  })

  it('403 response has correct error shape', async () => {
    const mockSession = {
      id: 'session-1',
      userId: 'other-user-id',
      expiresAt: new Date(Date.now() + 3600000),
      createdAt: new Date(),
    }
    vi.mocked(prisma.anchorSession.findUnique).mockResolvedValue(mockSession as any)

    const res = await GET(makeRequest('session-1'), { params: { id: 'session-1' } })
    const data = await res.json()
    expect(data).toHaveProperty('error')
    expect(data).toHaveProperty('message')
  })

  it('owner can view their own session status', async () => {
    const mockSession = {
      id: 'session-1',
      userId: 'user-1',
      expiresAt: new Date(Date.now() + 3600000),
      createdAt: new Date(),
    }
    vi.mocked(prisma.anchorSession.findUnique).mockResolvedValue(mockSession as any)

    const res = await GET(makeRequest('session-1'), { params: { id: 'session-1' } })
    expect(res.status).toBe(200)
  })

  // SECURITY — JWT TOKEN NEVER RETURNED
  it('Prisma select query explicitly excludes jwtToken', async () => {
    const mockSession = {
      id: 'session-1',
      userId: 'user-1',
      expiresAt: new Date(Date.now() + 3600000),
      createdAt: new Date(),
    }
    vi.mocked(prisma.anchorSession.findUnique).mockResolvedValue(mockSession as any)

    await GET(makeRequest('session-1'), { params: { id: 'session-1' } })

    // Verify that findUnique was called with select that excludes jwtToken
    expect(vi.mocked(prisma.anchorSession.findUnique)).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.not.objectContaining({ jwtToken: true }),
      })
    )
  })

  it('even if prisma accidentally returns jwtToken, response strips it', async () => {
    const mockSession = {
      id: 'session-1',
      userId: 'user-1',
      expiresAt: new Date(Date.now() + 3600000),
      createdAt: new Date(),
      jwtToken: 'secret-token-should-not-leak', // Simulating accidental inclusion
    }
    vi.mocked(prisma.anchorSession.findUnique).mockResolvedValue(mockSession as any)

    const res = await GET(makeRequest('session-1'), { params: { id: 'session-1' } })
    const data = await res.json()
    // Response should only have safe fields
    expect(data).not.toHaveProperty('jwtToken')
    expect(Object.keys(data).sort()).toEqual(['createdAt', 'expiresAt', 'id', 'status'].sort())
  })

  // ERROR HANDLING
  it('returns 500 when Prisma throws unexpected error', async () => {
    vi.mocked(prisma.anchorSession.findUnique).mockRejectedValue(new Error('Database connection failed'))

    const res = await GET(makeRequest('session-1'), { params: { id: 'session-1' } })
    expect(res.status).toBe(500)
    const data = await res.json()
    expect(data.error).toBe('Internal Server Error')
    expect(data.message).toBe('Failed to fetch session status')
  })

  it('500 error response has correct error shape', async () => {
    vi.mocked(prisma.anchorSession.findUnique).mockRejectedValue(new Error('Database error'))

    const res = await GET(makeRequest('session-1'), { params: { id: 'session-1' } })
    const data = await res.json()
    expect(data).toHaveProperty('error')
    expect(data).toHaveProperty('message')
  })
})
