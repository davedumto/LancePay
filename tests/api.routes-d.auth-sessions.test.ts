import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const sessionFindMany = vi.fn()

vi.mock('@/lib/auth', () => ({
  verifyAuthToken,
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    userSession: { findMany: sessionFindMany },
  },
}))

function getRequest(token?: string): NextRequest {
  const headers = new Headers()
  if (token) headers.set('authorization', `Bearer ${token}`)
  return new NextRequest('http://localhost/api/routes-d/auth/sessions', { headers })
}

describe('GET /api/routes-d/auth/sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when the auth token is invalid', async () => {
    verifyAuthToken.mockResolvedValue(null)

    const { GET } = await import('@/app/api/routes-d/auth/sessions/route')
    const response = await GET(getRequest())

    expect(response.status).toBe(401)
    expect(sessionFindMany).not.toHaveBeenCalled()
  })

  it('returns the user sessions and marks the current one via tokenHint', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    sessionFindMany.mockResolvedValue([
      {
        id: 'sess_1',
        deviceLabel: 'iPhone 15',
        userAgent: 'Safari/17.0',
        ipAddress: '203.0.113.1',
        tokenHint: 'abc123',
        issuedAt: new Date('2026-06-20T00:00:00Z'),
        lastSeenAt: new Date('2026-06-23T00:00:00Z'),
      },
      {
        id: 'sess_2',
        deviceLabel: 'MacBook',
        userAgent: 'Chrome/120',
        ipAddress: '203.0.113.2',
        tokenHint: 'xyz789',
        issuedAt: new Date('2026-06-15T00:00:00Z'),
        lastSeenAt: new Date('2026-06-22T00:00:00Z'),
      },
    ])

    const { GET } = await import('@/app/api/routes-d/auth/sessions/route')
    const response = await GET(getRequest('long.bearer.token.endingin.abc123'))

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.sessions).toHaveLength(2)
    expect(body.sessions[0].id).toBe('sess_1')
    expect(body.sessions[0].isCurrent).toBe(true)
    expect(body.sessions[1].isCurrent).toBe(false)

    expect(sessionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user_1', revokedAt: null },
      }),
    )
  })

  it('returns an empty list when the user has no active sessions', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    sessionFindMany.mockResolvedValue([])

    const { GET } = await import('@/app/api/routes-d/auth/sessions/route')
    const response = await GET(getRequest('any.token'))

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.sessions).toEqual([])
  })
})
