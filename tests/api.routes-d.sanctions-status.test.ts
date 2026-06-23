import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const sanctionsFindUnique = vi.fn()

vi.mock('@/lib/auth', () => ({
  verifyAuthToken,
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: userFindUnique,
    },
    sanctionsScreening: {
      findUnique: sanctionsFindUnique,
    },
  },
}))

describe('GET /api/routes-d/sanctions/status', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when the auth token is missing or invalid', async () => {
    verifyAuthToken.mockResolvedValue(null)

    const { GET } = await import('@/app/api/routes-d/sanctions/status/route')
    const request = new NextRequest('http://localhost/api/routes-d/sanctions/status')
    const response = await GET(request)

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Unauthorized' })
    expect(sanctionsFindUnique).not.toHaveBeenCalled()
  })

  it('returns an "unscreened" placeholder when no screening row exists', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    sanctionsFindUnique.mockResolvedValue(null)

    const { GET } = await import('@/app/api/routes-d/sanctions/status/route')
    const request = new NextRequest('http://localhost/api/routes-d/sanctions/status')
    const response = await GET(request)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: 'unscreened',
      provider: null,
      matchScore: null,
      screenedAt: null,
      expiresAt: null,
    })
  })

  it('returns the persisted screening record for the current user', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    sanctionsFindUnique.mockResolvedValue({
      status: 'clear',
      provider: 'ComplyAdvantage',
      matchScore: null,
      screenedAt: new Date('2026-06-23T00:00:00Z'),
      expiresAt: new Date('2026-12-23T00:00:00Z'),
    })

    const { GET } = await import('@/app/api/routes-d/sanctions/status/route')
    const request = new NextRequest('http://localhost/api/routes-d/sanctions/status')
    const response = await GET(request)

    expect(response.status).toBe(200)
    expect(sanctionsFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user_1' } }),
    )
    const body = await response.json()
    expect(body.status).toBe('clear')
    expect(body.provider).toBe('ComplyAdvantage')
    expect(body.matchScore).toBeNull()
  })
})
