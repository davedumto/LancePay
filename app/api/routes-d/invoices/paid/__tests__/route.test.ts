import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const invoiceFindMany = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    invoice: { findMany: invoiceFindMany },
  },
}))
vi.mock('@/lib/logger', () => ({
  logger: {
    error: vi.fn(),
  },
}))

const BASE_URL = 'http://localhost/api/routes-d/invoices/paid'

function makeRequest(token: string | null = 'valid-token') {
  const headers = new Headers()
  if (token) {
    headers.set('authorization', `Bearer ${token}`)
  }
  return new NextRequest(BASE_URL, {
    method: 'GET',
    headers,
  })
}

describe('GET /api/routes-d/invoices/paid', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 if no authorization header is provided', async () => {
    const { GET } = await import('../route')
    const res = await GET(makeRequest(null))
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toBe('Unauthorized')
  })

  it('returns 401 if token is invalid', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { GET } = await import('../route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toBe('Invalid token')
  })

  it('returns 404 if user is not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
    userFindUnique.mockResolvedValue(null)
    const { GET } = await import('../route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error).toBe('User not found')
  })

  it('returns list of paid invoices for the user', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
    userFindUnique.mockResolvedValue({ id: 'user-1' })
    
    const mockDate = new Date()
    invoiceFindMany.mockResolvedValue([
      {
        id: 'inv-1',
        invoiceNumber: 'INV-001',
        clientName: 'Client A',
        clientEmail: 'client@a.com',
        amount: '100.50',
        currency: 'USD',
        status: 'paid',
        paidAt: mockDate,
        createdAt: mockDate,
      },
    ])

    const { GET } = await import('../route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    
    const json = await res.json()
    expect(json.count).toBe(1)
    expect(json.invoices).toHaveLength(1)
    expect(json.invoices[0].id).toBe('inv-1')
    expect(json.invoices[0].amount).toBe(100.5)
    expect(json.invoices[0].status).toBe('paid')
    
    expect(invoiceFindMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        status: 'paid',
      },
      orderBy: { paidAt: 'desc' },
      select: expect.any(Object),
    })
  })

  it('returns 500 on unexpected database error', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy-123' })
    userFindUnique.mockRejectedValue(new Error('DB connection lost'))
    const { GET } = await import('../route')
    const res = await GET(makeRequest())
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.error).toBe('Internal Server Error')
  })
})
