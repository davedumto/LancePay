import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from './route'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    securityWatchlist: { findUnique: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/authorization', () => ({ isAdmin: vi.fn(() => false), isAdminEmail: vi.fn(() => false) }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUserFind = prisma.user.findUnique as unknown as ReturnType<typeof vi.fn>
const mockWatchlistFind = prisma.securityWatchlist.findUnique as unknown as ReturnType<typeof vi.fn>
const mockVerify = verifyAuthToken as unknown as ReturnType<typeof vi.fn>

function makeRequest(value = 'person@example.com', token: string | null = 'valid-token') {
  const headers = new Headers()
  if (token) headers.set('authorization', `Bearer ${token}`)
  return new NextRequest(`http://localhost/api/security-watchlist/check?value=${encodeURIComponent(value)}`, { headers })
}

describe('GET /api/security-watchlist/check', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerify.mockResolvedValue({ userId: 'privy-admin' })
    mockUserFind.mockResolvedValue({ id: 'compliance-1', role: 'compliance', email: 'compliance@example.com' })
    mockWatchlistFind.mockResolvedValue({ id: 'entry-1', type: 'email', value: 'person@example.com', reason: 'review', createdAt: new Date() })
  })

  it('rejects unauthenticated requests before querying the watchlist', async () => {
    const response = await GET(makeRequest('person@example.com', null))
    expect(response.status).toBe(401)
    expect(mockWatchlistFind).not.toHaveBeenCalled()
  })

  it('allows a compliance actor to check membership', async () => {
    const response = await GET(makeRequest())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ match: true, entry: { id: 'entry-1' } })
    expect(mockWatchlistFind).toHaveBeenCalledWith(expect.objectContaining({ where: { value: 'person@example.com' } }))
  })

  it('rejects authenticated non-compliance users', async () => {
    mockUserFind.mockResolvedValue({ id: 'user-1', role: 'freelancer', email: 'user@example.com' })
    const response = await GET(makeRequest())
    expect(response.status).toBe(403)
    expect(mockWatchlistFind).not.toHaveBeenCalled()
  })
})
