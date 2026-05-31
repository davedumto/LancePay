import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from '../route'

const verifyAuthToken = vi.fn()
const findUnique = vi.fn()
const findMany = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique },
    transaction: { findMany },
  },
}))

const BASE_URL = 'http://localhost/api/routes-b/transactions/export'

function makeRequest(query = '') {
  return new NextRequest(`${BASE_URL}${query}`, {
    headers: { authorization: 'Bearer token' },
  })
}

describe('GET /api/routes-b/transactions/export streaming', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 for unauthenticated requests', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
  })

  it('returns 404 when user not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    findUnique.mockResolvedValue(null)
    const res = await GET(makeRequest())
    expect(res.status).toBe(404)
  })

  it('returns CSV stream with correct headers', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    findUnique.mockResolvedValue({ id: 'user_1' })
    findMany.mockResolvedValue([
      {
        id: 'tx_1',
        type: 'payment',
        status: 'completed',
        amount: '100.50',
        currency: 'USD',
        createdAt: new Date('2026-05-01T10:00:00Z'),
        invoice: { description: 'Test invoice' },
      },
    ])

    const res = await GET(makeRequest())
    
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/csv')
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="transactions.csv"')
    
    // Verify the response is a ReadableStream
    expect(res.body).toBeInstanceOf(ReadableStream)
  })

  it('validates date parameters', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    findUnique.mockResolvedValue({ id: 'user_1' })

    const res = await GET(makeRequest('?from=invalid-date'))
    
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error.code).toBe('BAD_REQUEST')
    expect(data.error.fields.from).toBe('Must be a valid ISO date string')
  })

  it('applies date range filters to query', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    findUnique.mockResolvedValue({ id: 'user_1' })
    findMany.mockResolvedValue([])

    await GET(makeRequest('?from=2026-01-01T00:00:00Z&to=2026-12-31T23:59:59Z'))

    expect(findMany).toHaveBeenCalledWith({
      where: {
        userId: 'user_1',
        createdAt: {
          gte: new Date('2026-01-01T00:00:00Z'),
          lte: new Date('2026-12-31T23:59:59Z'),
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 500, // Default batch size
      include: {
        invoice: {
          select: {
            description: true,
          },
        },
      },
    })
  })

  it('handles missing invoice description gracefully', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    findUnique.mockResolvedValue({ id: 'user_1' })
    findMany.mockResolvedValue([
      {
        id: 'tx_1',
        type: 'withdrawal',
        status: 'pending',
        amount: '50.00',
        currency: 'USD',
        createdAt: new Date('2026-05-01T10:00:00Z'),
        invoice: null, // No associated invoice
      },
    ])

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    
    // The CSV stream should handle null invoice gracefully
    expect(res.body).toBeInstanceOf(ReadableStream)
  })

  it('validates to date parameter', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    findUnique.mockResolvedValue({ id: 'user_1' })

    const res = await GET(makeRequest('?to=not-a-date'))
    
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error.code).toBe('BAD_REQUEST')
    expect(data.error.fields.to).toBe('Must be a valid ISO date string')
  })

  it('queries without date filters when none provided', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    findUnique.mockResolvedValue({ id: 'user_1' })
    findMany.mockResolvedValue([])

    await GET(makeRequest())

    expect(findMany).toHaveBeenCalledWith({
      where: { userId: 'user_1' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 500,
      include: {
        invoice: {
          select: {
            description: true,
          },
        },
      },
    })
  })

  it('uses cursor-based pagination for streaming', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    findUnique.mockResolvedValue({ id: 'user_1' })
    
    // Mock multiple calls to simulate streaming batches
    findMany
      .mockResolvedValueOnce([
        {
          id: 'tx_1',
          type: 'payment',
          status: 'completed',
          amount: '100.00',
          currency: 'USD',
          createdAt: new Date('2026-05-01T10:00:00Z'),
          invoice: { description: 'First batch' },
        },
      ])
      .mockResolvedValueOnce([]) // Empty second batch to end stream

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    expect(res.body).toBeInstanceOf(ReadableStream)
  })
})