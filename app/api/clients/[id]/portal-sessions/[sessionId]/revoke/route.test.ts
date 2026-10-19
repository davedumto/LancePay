import { describe, it, expect, beforeEach, vi } from 'vitest'
import { POST } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn(), findFirst: vi.fn() },
    invoice: { findFirst: vi.fn() },
    clientPortalSession: { findFirst: vi.fn(), update: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUserId = 'user-123'
const mockPrivyId = 'privy-123'
const mockClientId = 'client-123'
const mockSessionId = 'session-123'
const params = { id: mockClientId, sessionId: mockSessionId }

function makeRequest() {
  return new NextRequest(
    `http://localhost:3000/api/clients/${mockClientId}/portal-sessions/${mockSessionId}/revoke`,
    {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token' },
    },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: mockPrivyId } as never)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: mockUserId } as never)
  vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: mockClientId } as never)
  vi.mocked(prisma.invoice.findFirst).mockResolvedValue({ id: 'invoice-1' } as never)
})

describe('POST /api/clients/[id]/portal-sessions/[sessionId]/revoke', () => {
  it('revokes an active portal session', async () => {
    const mockSession = {
      id: mockSessionId,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 86400000),
    }
    vi.mocked(prisma.clientPortalSession.findFirst).mockResolvedValue(mockSession as never)

    const revokedSession = {
      id: mockSessionId,
      revokedAt: new Date(),
    }
    vi.mocked(prisma.clientPortalSession.update).mockResolvedValue(revokedSession as never)

    const res = await POST(makeRequest(), { params })
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.session.status).toBe('revoked')
    expect(data.session.id).toBe(mockSessionId)
    expect(prisma.clientPortalSession.update).toHaveBeenCalledWith({
      where: { id: mockSessionId },
      data: { revokedAt: expect.any(Date) },
      select: expect.any(Object),
    })
  })

  it('returns 409 when session is already revoked', async () => {
    const mockSession = {
      id: mockSessionId,
      revokedAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000),
    }
    vi.mocked(prisma.clientPortalSession.findFirst).mockResolvedValue(mockSession as never)

    const res = await POST(makeRequest(), { params })
    const data = await res.json()

    expect(res.status).toBe(409)
    expect(data.session.status).toBe('revoked')
    expect(prisma.clientPortalSession.update).not.toHaveBeenCalled()
  })

  it('returns 409 when session is already expired', async () => {
    const mockSession = {
      id: mockSessionId,
      revokedAt: null,
      expiresAt: new Date(Date.now() - 86400000),
    }
    vi.mocked(prisma.clientPortalSession.findFirst).mockResolvedValue(mockSession as never)

    const res = await POST(makeRequest(), { params })
    const data = await res.json()

    expect(res.status).toBe(409)
    expect(data.session.status).toBe('expired')
    expect(prisma.clientPortalSession.update).not.toHaveBeenCalled()
  })

  it('returns 404 when session does not exist', async () => {
    vi.mocked(prisma.clientPortalSession.findFirst).mockResolvedValue(null)

    const res = await POST(makeRequest(), { params })
    expect(res.status).toBe(404)
  })

  it('returns 404 when client does not exist', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null)

    const res = await POST(makeRequest(), { params })
    expect(res.status).toBe(404)
  })

  it('returns 401 when no auth token provided', async () => {
    const request = new NextRequest(
      `http://localhost:3000/api/clients/${mockClientId}/portal-sessions/${mockSessionId}/revoke`,
      {
        method: 'POST',
      },
    )
    const res = await POST(request, { params })
    expect(res.status).toBe(401)
  })

  it('ensures only the session owner can revoke their own session', async () => {
    const mockSession = {
      id: mockSessionId,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 86400000),
    }
    vi.mocked(prisma.clientPortalSession.findFirst).mockResolvedValue(mockSession as never)

    const revokedSession = {
      id: mockSessionId,
      revokedAt: new Date(),
    }
    vi.mocked(prisma.clientPortalSession.update).mockResolvedValue(revokedSession as never)

    await POST(makeRequest(), { params })

    expect(prisma.clientPortalSession.findFirst).toHaveBeenCalledWith({
      where: {
        id: mockSessionId,
        userId: mockUserId,
        clientId: mockClientId,
      },
      select: expect.any(Object),
    })
  })

  it('returns 500 on database error', async () => {
    vi.mocked(prisma.clientPortalSession.findFirst).mockRejectedValue(new Error('Database error'))

    const res = await POST(makeRequest(), { params })
    expect(res.status).toBe(500)
  })
})
