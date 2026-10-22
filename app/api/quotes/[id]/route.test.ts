import { describe, it, expect, beforeEach, vi } from 'vitest'
import { GET, PATCH } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    quote: { findFirst: vi.fn(), update: vi.fn() },
    quoteLineItem: { deleteMany: vi.fn(), createMany: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUserId = 'user-123'
const mockPrivyId = 'privy-123'
const mockQuoteId = 'quote-123'
const params = { id: mockQuoteId }

function makeRequest(method: 'GET' | 'PATCH' = 'GET', body?: any) {
  return new NextRequest(`http://localhost:3000/api/quotes/${mockQuoteId}`, {
    method,
    headers: { Authorization: 'Bearer valid-token' },
    body: body ? JSON.stringify(body) : undefined,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: mockPrivyId } as never)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: mockUserId } as never)
})

describe('GET /api/quotes/[id]', () => {
  it('returns the quote for the authenticated owner', async () => {
    const mockQuote = {
      id: mockQuoteId,
      clientEmail: 'client@example.com',
      clientName: 'Acme Corp',
      description: 'Website redesign',
      amount: 1500,
      currency: 'USD',
      status: 'pending',
      invoiceId: null,
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lineItems: [],
    }
    vi.mocked(prisma.quote.findFirst).mockResolvedValue(mockQuote as never)

    const res = await GET(makeRequest('GET'), { params })
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.quote.id).toBe(mockQuoteId)
    expect(data.quote.amount).toBe(1500)
  })

  it('returns 401 when no auth token provided', async () => {
    const request = new NextRequest(`http://localhost:3000/api/quotes/${mockQuoteId}`)
    const res = await GET(request, { params })
    const data = await res.json()
    expect(res.status).toBe(401)
    expect(data.error).toBe('Unauthorized')
  })

  it('returns 401 when the token is invalid', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await GET(makeRequest('GET'), { params })
    expect(res.status).toBe(401)
  })

  it('returns 404 when the user record cannot be found', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
    const res = await GET(makeRequest('GET'), { params })
    expect(res.status).toBe(404)
  })

  it('returns 404 when the quote does not exist or belongs to another user', async () => {
    vi.mocked(prisma.quote.findFirst).mockResolvedValue(null)
    const res = await GET(makeRequest('GET'), { params })
    const data = await res.json()
    expect(res.status).toBe(404)
    expect(data.error).toBe('Quote not found')
  })

  it('scopes the lookup to the authenticated user (ownership check)', async () => {
    vi.mocked(prisma.quote.findFirst).mockResolvedValue({
      id: mockQuoteId,
      amount: 100,
      lineItems: [],
    } as never)
    await GET(makeRequest('GET'), { params })
    expect(prisma.quote.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: mockQuoteId, userId: mockUserId } }),
    )
  })

  it('returns 500 on database error', async () => {
    vi.mocked(prisma.quote.findFirst).mockRejectedValue(new Error('Database connection failed'))
    const res = await GET(makeRequest('GET'), { params })
    const data = await res.json()
    expect(res.status).toBe(500)
    expect(data.error).toBe('Failed to fetch quote')
  })
})

describe('PATCH /api/quotes/[id]', () => {
  it('returns 401 when no auth token provided', async () => {
    const request = new NextRequest(`http://localhost:3000/api/quotes/${mockQuoteId}`, {
      method: 'PATCH',
      body: JSON.stringify({ clientName: 'Updated Name' }),
    })
    const res = await PATCH(request, { params })
    const data = await res.json()
    expect(res.status).toBe(401)
    expect(data.error).toBe('Unauthorized')
  })

  it('returns 401 when the token is invalid', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await PATCH(makeRequest('PATCH', { clientName: 'Updated Name' }), { params })
    expect(res.status).toBe(401)
  })

  it('returns 404 when the quote does not exist or belongs to another user', async () => {
    vi.mocked(prisma.quote.findFirst).mockResolvedValue(null)
    const res = await PATCH(makeRequest('PATCH', { clientName: 'Updated Name' }), { params })
    const data = await res.json()
    expect(res.status).toBe(404)
    expect(data.error).toBe('Quote not found')
  })

  it('rejects updates to a quote that has been converted to an invoice', async () => {
    vi.mocked(prisma.quote.findFirst).mockResolvedValue({
      id: mockQuoteId,
      invoiceId: 'invoice-123',
    } as never)

    const res = await PATCH(makeRequest('PATCH', { clientName: 'Updated Name' }), { params })
    const data = await res.json()
    expect(res.status).toBe(409)
    expect(data.error).toContain('Cannot update a quote that has been converted to an invoice')
  })

  it('updates basic fields without line items', async () => {
    const mockQuote = {
      id: mockQuoteId,
      invoiceId: null,
    }
    vi.mocked(prisma.quote.findFirst).mockResolvedValue(mockQuote as never)

    const updatedQuote = {
      id: mockQuoteId,
      clientEmail: 'updated@example.com',
      clientName: 'Updated Corp',
      description: 'Updated description',
      amount: 2000,
      currency: 'USD',
      status: 'pending',
      invoiceId: null,
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lineItems: [],
    }
    vi.mocked(prisma.quote.update).mockResolvedValue(updatedQuote as never)

    const res = await PATCH(
      makeRequest('PATCH', {
        clientEmail: 'updated@example.com',
        clientName: 'Updated Corp',
        description: 'Updated description',
        amount: 2000,
      }),
      { params },
    )
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.quote.clientName).toBe('Updated Corp')
    expect(prisma.quote.update).toHaveBeenCalled()
  })

  it('recomputes total when line items are changed', async () => {
    const mockQuote = {
      id: mockQuoteId,
      invoiceId: null,
    }
    vi.mocked(prisma.quote.findFirst).mockResolvedValue(mockQuote as never)

    const updatedQuote = {
      id: mockQuoteId,
      clientEmail: 'client@example.com',
      clientName: 'Acme Corp',
      description: 'Website redesign',
      amount: 300, // 100 * 2 + 50 * 2
      currency: 'USD',
      status: 'pending',
      invoiceId: null,
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lineItems: [
        {
          id: 'item-1',
          productId: null,
          description: 'Design',
          quantity: 2,
          unitPrice: 100,
          position: 0,
        },
        {
          id: 'item-2',
          productId: null,
          description: 'Development',
          quantity: 2,
          unitPrice: 50,
          position: 1,
        },
      ],
    }

    vi.mocked(prisma.quote.findFirst).mockResolvedValueOnce(mockQuote as never)
    vi.mocked(prisma.quoteLineItem.deleteMany).mockResolvedValue({ count: 0 })
    vi.mocked(prisma.quoteLineItem.createMany).mockResolvedValue({ count: 2 })
    vi.mocked(prisma.quote.findFirst).mockResolvedValueOnce(updatedQuote as never)

    const newLineItems = [
      { productId: null, description: 'Design', quantity: 2, unitPrice: 100 },
      { productId: null, description: 'Development', quantity: 2, unitPrice: 50 },
    ]

    const res = await PATCH(makeRequest('PATCH', { lineItems: newLineItems }), { params })
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.quote.amount).toBe(300)
    expect(prisma.quoteLineItem.deleteMany).toHaveBeenCalledWith({ where: { quoteId: mockQuoteId } })
    expect(prisma.quoteLineItem.createMany).toHaveBeenCalled()
  })

  it('scopes the update to the authenticated user (ownership check)', async () => {
    const mockQuote = {
      id: mockQuoteId,
      invoiceId: null,
    }
    vi.mocked(prisma.quote.findFirst).mockResolvedValue(mockQuote as never)
    await PATCH(makeRequest('PATCH', { clientName: 'Updated' }), { params })
    expect(prisma.quote.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: mockQuoteId, userId: mockUserId } }),
    )
  })

  it('returns 500 on database error', async () => {
    vi.mocked(prisma.quote.findFirst).mockRejectedValue(new Error('Database connection failed'))
    const res = await PATCH(makeRequest('PATCH', { clientName: 'Updated' }), { params })
    const data = await res.json()
    expect(res.status).toBe(500)
    expect(data.error).toBe('Failed to update quote')
  })
})
