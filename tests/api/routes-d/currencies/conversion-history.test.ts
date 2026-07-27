import { NextRequest } from 'next/server'
import { GET } from '@/app/api/routes-d/currencies/conversion-history/route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    transaction: { findMany: vi.fn(), count: vi.fn() }
  }
}))

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn()
}))

describe('GET /api/routes-d/currencies/conversion-history', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function createRequest(url: string, token?: string) {
    const headers = new Headers()
    if (token) headers.set('authorization', `Bearer ${token}`)
    
    return new NextRequest(new URL(url, 'http://localhost'), {
      headers
    })
  }

  it('returns 401 if no auth token provided', async () => {
    const req = createRequest('/api/routes-d/currencies/conversion-history')
    const res = await GET(req)
    expect(res.status).toBe(401)
    
    const body = await res.json()
    expect(body.error).toBe('Unauthorized')
  })

  it('returns 401 if invalid auth token', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValueOnce(null)
    const req = createRequest('/api/routes-d/currencies/conversion-history', 'invalid')
    const res = await GET(req)
    expect(res.status).toBe(401)
  })

  it('returns 404 if user not found', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValueOnce({ userId: 'privy123' })
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(null)

    const req = createRequest('/api/routes-d/currencies/conversion-history', 'valid')
    const res = await GET(req)
    expect(res.status).toBe(404)
  })

  it('returns 400 for invalid limit', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValueOnce({ userId: 'privy123' })
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: 'user1' } as any)

    const req = createRequest('/api/routes-d/currencies/conversion-history?limit=invalid', 'valid')
    const res = await GET(req)
    expect(res.status).toBe(400)
  })

  it('returns conversion history successfully', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValueOnce({ userId: 'privy123' })
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: 'user1' } as any)

    const mockTransactions = [
      {
        id: 'tx1',
        status: 'completed',
        amount: 100,
        currency: 'USD',
        ngnAmount: 150000,
        exchangeRate: 1500,
        txHash: 'hash1',
        createdAt: new Date('2026-07-27T10:00:00Z'),
        completedAt: new Date('2026-07-27T10:01:00Z')
      }
    ]

    vi.mocked(prisma.transaction.findMany).mockResolvedValueOnce(mockTransactions as any)
    vi.mocked(prisma.transaction.count).mockResolvedValueOnce(1)

    const req = createRequest('/api/routes-d/currencies/conversion-history', 'valid')
    const res = await GET(req)
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.history).toHaveLength(1)
    expect(body.history[0].id).toBe('tx1')
    expect(body.pagination.total).toBe(1)
    
    expect(prisma.transaction.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'user1', type: 'conversion' },
      take: 20,
      skip: 0
    }))
  })
})
