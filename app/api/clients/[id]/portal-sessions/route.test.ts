import { describe, it, expect, beforeEach, vi } from 'vitest'
import { GET, POST } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn(), findFirst: vi.fn() },
    invoice: { findFirst: vi.fn() },
    clientPortalSession: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/crypto', () => ({
  generateToken: vi.fn(() => 'test-token-12345678'),
  hashToken: vi.fn(() => 'hashed-token-123'),
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { generateToken } from '@/lib/crypto'

const mockUserId = 'user-123'
const mockPrivyId = 'privy-123'
const mockClientId = 'client-123'
const params = { id: mockClientId }

function makeRequest(method: 'GET' | 'POST', body?: any) {
  return new NextRequest(`http://localhost:3000/api/clients/${mockClientId}/portal-sessions`, {
    method,
    headers: { Authorization: 'Bearer valid-token' },
    body: body ? JSON.stringify(body) : undefined,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: mockPrivyId } as never)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: mockUserId } as never)
  vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: mockClientId, email: 'client@example.com' } as never)
  vi.mocked(prisma.invoice.findFirst).mockResolvedValue({ id: 'invoice-1' } as never)
})

describe('GET /api/clients/[id]/portal-sessions', () => {
  it('returns portal sessions for the authenticated owner', async () => {
    const mockSessions = [
      {
        id: 'session-1',
        tokenHint: '12345678',
        lastSeenAt: new Date(),
        revokedAt: null,
        expiresAt: new Date(Date.now() + 86400000),
        createdAt: new Date(),
      },
    ]
    vi.mocked(prisma.clientPortalSession.findMany).mockResolvedValue(mockSessions as never)

    const res = await GET(makeRequest('GET'), { params })
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.sessions).toHaveLength(1)
    expect(data.sessions[0].status).toBe('active')
  })

  it('returns 401 when no auth token provided', async () => {
    const request = new NextRequest(`http://localhost:3000/api/clients/${mockClientId}/portal-sessions`)
    const res = await GET(request, { params })
    expect(res.status).toBe(401)
  })

  it('returns 404 when client does not exist', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null)
    const res = await GET(makeRequest('GET'), { params })
    expect(res.status).toBe(404)
  })

  it('returns 500 on database error', async () => {
    vi.mocked(prisma.clientPortalSession.findMany).mockRejectedValue(new Error('Database error'))
    const res = await GET(makeRequest('GET'), { params })
    expect(res.status).toBe(500)
  })
})

describe('POST /api/clients/[id]/portal-sessions', () => {
  it('issues a new portal session and returns the raw token', async () => {
    const mockSession = {
      id: 'session-1',
      tokenHint: '12345678',
      expiresAt: new Date(Date.now() + 86400000),
      createdAt: new Date(),
    }
    vi.mocked(prisma.clientPortalSession.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.clientPortalSession.create).mockResolvedValue(mockSession as never)

    const res = await POST(makeRequest('POST'), { params })
    const data = await res.json()

    expect(res.status).toBe(201)
    expect(data.session.token).toBe('test-token-12345678')
    expect(data.session.tokenHint).toBe('12345678')
    expect(prisma.clientPortalSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: mockUserId,
        clientId: mockClientId,
        hashedToken: 'hashed-token-123',
        tokenHint: '12345678',
      }),
      select: expect.any(Object),
    })
  })

  it('returns existing active session instead of creating a duplicate', async () => {
    const existingSession = {
      id: 'session-1',
      tokenHint: '12345678',
      expiresAt: new Date(Date.now() + 86400000),
      createdAt: new Date(),
    }
    vi.mocked(prisma.clientPortalSession.findFirst).mockResolvedValue(existingSession as never)

    const res = await POST(makeRequest('POST'), { params })
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.session.id).toBe('session-1')
    expect(prisma.clientPortalSession.create).not.toHaveBeenCalled()
  })

  it('uses default expiration when not provided', async () => {
    const mockSession = {
      id: 'session-1',
      tokenHint: '12345678',
      expiresAt: new Date(Date.now() + 604800000),
      createdAt: new Date(),
    }
    vi.mocked(prisma.clientPortalSession.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.clientPortalSession.create).mockResolvedValue(mockSession as never)

    const res = await POST(makeRequest('POST'), { params })
    expect(res.status).toBe(201)
  })

  it('uses custom expiration when provided', async () => {
    const mockSession = {
      id: 'session-1',
      tokenHint: '12345678',
      expiresAt: new Date(Date.now() + 3600000),
      createdAt: new Date(),
    }
    vi.mocked(prisma.clientPortalSession.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.clientPortalSession.create).mockResolvedValue(mockSession as never)

    const res = await POST(makeRequest('POST', { expiresInSeconds: 3600 }), { params })
    expect(res.status).toBe(201)
  })

  it('rejects expiresInSeconds greater than max', async () => {
    const res = await POST(makeRequest('POST', { expiresInSeconds: 999999999 }), { params })
    expect(res.status).toBe(400)
  })

  it('rejects non-positive expiresInSeconds', async () => {
    const res = await POST(makeRequest('POST', { expiresInSeconds: -1 }), { params })
    expect(res.status).toBe(400)
  })

  it('returns 401 when no auth token provided', async () => {
    const request = new NextRequest(`http://localhost:3000/api/clients/${mockClientId}/portal-sessions`, {
      method: 'POST',
    })
    const res = await POST(request, { params })
    expect(res.status).toBe(401)
  })

  it('returns 404 when client does not exist', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null)
    const res = await POST(makeRequest('POST'), { params })
    expect(res.status).toBe(404)
  })
})
