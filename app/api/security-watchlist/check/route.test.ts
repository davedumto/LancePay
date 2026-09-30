import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from './route'

vi.mock('@/lib/db', () => ({
  prisma: {
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
