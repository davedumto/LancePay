import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from './route'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    userSession: { upsert: vi.fn(), findMany: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUserFind = prisma.user.findUnique as unknown as ReturnType<typeof vi.fn>
const mockUpsert = prisma.userSession.upsert as unknown as ReturnType<typeof vi.fn>
const mockFindMany = prisma.userSession.findMany as unknown as ReturnType<typeof vi.fn>
const mockVerify = verifyAuthToken as unknown as ReturnType<typeof vi.fn>

function makeRequest(token: string | null = 'valid-token') {
  const headers = new Headers()
  if (token) headers.set('authorization', `Bearer ${token}`)
  return new NextRequest('http://localhost/api/user/sessions', { headers })
}

describe('GET /api/user/sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerify.mockResolvedValue({ userId: 'privy-user', sessionId: 'current-session' })
    mockUserFind.mockResolvedValue({ id: 'user-1' })
    mockUpsert.mockResolvedValue({ id: 'row-current', userId: 'user-1', providerSessionId: 'current-session' })
    mockFindMany.mockResolvedValue([
      { id: 'row-current', tokenHint: 'current-hint', providerSessionId: 'current-session', revokedAt: null },
      { id: 'row-revoked', tokenHint: 'revoked-hint', providerSessionId: 'old-session', revokedAt: new Date() },
    ])
  })

  it('rejects unauthenticated requests', async () => {
    expect((await GET(makeRequest(null))).status).toBe(401)
  })

  it('lists sessions in last-seen order without exposing a session token', async () => {
    const response = await GET(makeRequest())
    expect(response.status).toBe(200)
    const json = await response.json()
    expect(json.sessions[0]).toMatchObject({ isActive: true, isCurrent: true, tokenHint: 'current-hint' })
    expect(json.sessions[1]).toMatchObject({ isActive: false, isCurrent: false })
    expect(json.sessions[0]).not.toHaveProperty('providerSessionId')
    expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: { lastSeenAt: 'desc' } }))
  })

  it('rejects requests when the user has no database account', async () => {
    mockUserFind.mockResolvedValue(null)
    expect((await GET(makeRequest())).status).toBe(401)
    expect(mockFindMany).not.toHaveBeenCalled()
  })
})