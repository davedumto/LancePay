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
vi.mock('@/lib/authorization', () => ({ isAdminEmail: vi.fn(() => false) }))
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
    securityWatchlist: {
      findFirst: vi.fn(),
    },
  },
}))

import { prisma } from '@/lib/db'

function request(url = 'http://localhost/api/security-watchlist/check') {
  return new NextRequest(url)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/security-watchlist/check', () => {
  it('returns 400 when value is missing', async () => {
    const response = await GET(request())
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Missing value parameter' })
  })

  it('normalizes and matches an email address', async () => {
    vi.mocked(prisma.securityWatchlist.findFirst).mockResolvedValue({
      id: '1',
      type: 'email',
      value: 'test@example.com',
      reason: 'Spam',
      createdAt: new Date(),
    } as any)

    const response = await GET(request('http://localhost/api/security-watchlist/check?value=  TEST@example.com  &type=email'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ match: true, type: 'email' })
    expect(prisma.securityWatchlist.findFirst).toHaveBeenCalledWith({
      where: { value: 'test@example.com', type: 'email' },
    })
  })

  it('normalizes and matches an EVM wallet address', async () => {
    vi.mocked(prisma.securityWatchlist.findFirst).mockResolvedValue({
      id: '2',
      type: 'wallet',
      value: '0xabc123',
      reason: 'Sanctioned',
      createdAt: new Date(),
    } as any)

    const response = await GET(request('http://localhost/api/security-watchlist/check?value=0xAbC123&type=wallet'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ match: true, type: 'wallet' })
    expect(prisma.securityWatchlist.findFirst).toHaveBeenCalledWith({
      where: { value: '0xabc123', type: 'wallet' },
    })
  })

  it('infers email type if not provided and normalizes it', async () => {
    vi.mocked(prisma.securityWatchlist.findFirst).mockResolvedValue({
      id: '3',
      type: 'email',
      value: 'hello@world.com',
      reason: 'Malicious',
      createdAt: new Date(),
    } as any)

    const response = await GET(request('http://localhost/api/security-watchlist/check?value=HELLO@world.com'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ match: true, type: 'email' })
    expect(prisma.securityWatchlist.findFirst).toHaveBeenCalledWith({
      where: { value: 'hello@world.com', type: 'email' },
    })
  })

  it('returns match false when not found', async () => {
    vi.mocked(prisma.securityWatchlist.findFirst).mockResolvedValue(null)

    const response = await GET(request('http://localhost/api/security-watchlist/check?value=clean@example.com'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ match: false })
  })

  it('returns 500 when the database fails', async () => {
    vi.mocked(prisma.securityWatchlist.findFirst).mockRejectedValue(new Error('database unavailable'))
    
    const response = await GET(request('http://localhost/api/security-watchlist/check?value=error@example.com'))
    
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Internal Server Error' })
  })
})
