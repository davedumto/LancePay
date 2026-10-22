import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from './route'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    userSession: { upsert: vi.fn(), updateMany: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUserFind = prisma.user.findUnique as unknown as ReturnType<typeof vi.fn>
const mockUpsert = prisma.userSession.upsert as unknown as ReturnType<typeof vi.fn>
const mockUpdateMany = prisma.userSession.updateMany as unknown as ReturnType<typeof vi.fn>
const mockVerify = verifyAuthToken as unknown as ReturnType<typeof vi.fn>

function makeRequest(token: string | null = 'valid-token') {
  const headers = new Headers()
  if (token) headers.set('authorization', `Bearer ${token}`)
  return new NextRequest('http://localhost/api/user/sessions/revoke-all-others', { method: 'POST', headers })
}

describe('POST /api/user/sessions/revoke-all-others', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerify.mockResolvedValue({ userId: 'privy-user', sessionId: 'current-session' })
    mockUserFind.mockResolvedValue({ id: 'user-1' })
    mockUpsert.mockResolvedValue({ userId: 'user-1' })
    mockUpdateMany.mockResolvedValue({ count: 2 })
  })

  it('rejects unauthenticated requests', async () => {
    expect((await POST(makeRequest(null))).status).toBe(401)
  })

  it('revokes only other active sessions and reports the count', async () => {
    const response = await POST(makeRequest())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ revokedCount: 2 })
    expect(mockUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        userId: 'user-1',
        OR: [
          { providerSessionId: { not: 'current-session' } },
          { providerSessionId: null },
        ],
        revokedAt: null,
      },
    }))
  })

  it('returns 404 when the authenticated user does not exist', async () => {
    mockUserFind.mockResolvedValue(null)
    expect((await POST(makeRequest())).status).toBe(404)
    expect(mockUpdateMany).not.toHaveBeenCalled()
  })
})