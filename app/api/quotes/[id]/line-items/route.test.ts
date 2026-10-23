import { describe, it, expect, beforeEach, vi } from 'vitest'
import { GET, POST, PATCH, DELETE } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    quote: { findFirst: vi.fn(), update: vi.fn() },
    quoteLineItem: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
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

function makeRequest(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', body?: any) {
  return new NextRequest(`http://localhost:3000/api/quotes/${mockQuoteId}/line-items`, {
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

describe('GET /api/quotes/[id]/line-items', () => {
  it('returns line items for the authenticated owner', async () => {
    const mockQuote = { id: mockQuoteId, invoiceId: null, amount: 100 }
    vi.mocked(prisma.quote.findFirst).mockResolvedValue(mockQuote as never)

    const mockLineItems = [
      {
        id: 'item-1',
        productId: null,
        description: 'Design',
        quantity: 2,
        unitPrice: 100,
        position: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]
    vi.mocked(prisma.quoteLineItem.findMany).mockResolvedValue(mockLineItems as never)

    const res = await GET(makeRequest('GET'), { params })
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.lineItems).toHaveLength(1)
    expect(data.lineItems[0].description).toBe('Design')
  })

  it('returns 401 when no auth token provided', async () => {
    const request = new NextRequest(`http://localhost:3000/api/quotes/${mockQuoteId}/line-items`)
    const res = await GET(request, { params })
    expect(res.status).toBe(401)
  })

  it('returns 404 when quote does not exist', async () => {
    vi.mocked(prisma.quote.findFirst).mockResolvedValue(null)
    const res = await GET(makeRequest('GET'), { params })
    expect(res.status).toBe(404)
  })

  it('returns 500 on database error', async () => {
    vi.mocked(prisma.quote.findFirst).mockRejectedValue(new Error('Database error'))
    const res = await GET(makeRequest('GET'), { params })
    expect(res.status).toBe(500)
  })
})

describe('POST /api/quotes/[id]/line-items', () => {
  it('adds a line item to a quote', async () => {
    const mockQuote = { id: mockQuoteId, invoiceId: null, amount: 100 }
    vi.mocked(prisma.quote.findFirst).mockResolvedValue(mockQuote as never)
    vi.mocked(prisma.quoteLineItem.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.quote.update).mockResolvedValue(mockQuote as never)

    const mockLineItem = {
      id: 'item-1',
      productId: null,
      description: 'Design',
      quantity: 2,
      unitPrice: 100,
      position: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    vi.mocked(prisma.quoteLineItem.create).mockResolvedValue(mockLineItem as never)

    const res = await POST(
      makeRequest('POST', { description: 'Design', quantity: 2, unitPrice: 100 }),
      { params },
    )
    const data = await res.json()

    expect(res.status).toBe(201)
    expect(data.lineItem.description).toBe('Design')
    expect(prisma.quoteLineItem.create).toHaveBeenCalled()
  })

  it('rejects negative quantity', async () => {
    const mockQuote = { id: mockQuoteId, invoiceId: null, amount: 100 }
    vi.mocked(prisma.quote.findFirst).mockResolvedValue(mockQuote as never)

    const res = await POST(
      makeRequest('POST', { description: 'Design', quantity: -1, unitPrice: 100 }),
      { params },
    )
    expect(res.status).toBe(400)
  })

  it('rejects negative unitPrice', async () => {
    const mockQuote = { id: mockQuoteId, invoiceId: null, amount: 100 }
    vi.mocked(prisma.quote.findFirst).mockResolvedValue(mockQuote as never)

    const res = await POST(
      makeRequest('POST', { description: 'Design', quantity: 2, unitPrice: -10 }),
      { params },
    )
    expect(res.status).toBe(400)
  })

  it('rejects updates to a converted quote', async () => {
    const mockQuote = { id: mockQuoteId, invoiceId: 'invoice-123', amount: 100 }
    vi.mocked(prisma.quote.findFirst).mockResolvedValue(mockQuote as never)

    const res = await POST(
      makeRequest('POST', { description: 'Design', quantity: 2, unitPrice: 100 }),
      { params },
    )
    expect(res.status).toBe(409)
  })

  it('returns 401 when no auth token provided', async () => {
    const request = new NextRequest(`http://localhost:3000/api/quotes/${mockQuoteId}/line-items`, {
      method: 'POST',
      body: JSON.stringify({ description: 'Design', quantity: 2, unitPrice: 100 }),
    })
    const res = await POST(request, { params })
    expect(res.status).toBe(401)
  })
})

describe('PATCH /api/quotes/[id]/line-items', () => {
  it('updates multiple line items', async () => {
    const mockQuote = { id: mockQuoteId, invoiceId: null, amount: 100 }
    vi.mocked(prisma.quote.findFirst).mockResolvedValue(mockQuote as never)
    vi.mocked(prisma.quoteLineItem.update).mockResolvedValue({} as never)
    vi.mocked(prisma.quote.update).mockResolvedValue(mockQuote as never)

    const mockLineItems = [
      {
        id: 'item-1',
        productId: null,
        description: 'Design',
        quantity: 2,
        unitPrice: 100,
        position: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]
    vi.mocked(prisma.quoteLineItem.findMany).mockResolvedValue(mockLineItems as never)

    const res = await PATCH(
      makeRequest('PATCH', {
        lineItems: [{ id: 'item-1', description: 'Updated Design', quantity: 3, unitPrice: 150, position: 0 }],
      }),
      { params },
    )
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.lineItems).toHaveLength(1)
  })

  it('rejects negative quantity in update', async () => {
    const mockQuote = { id: mockQuoteId, invoiceId: null, amount: 100 }
    vi.mocked(prisma.quote.findFirst).mockResolvedValue(mockQuote as never)

    const res = await PATCH(
      makeRequest('PATCH', {
        lineItems: [{ id: 'item-1', quantity: -1 }],
      }),
      { params },
    )
    expect(res.status).toBe(400)
  })

  it('rejects negative unitPrice in update', async () => {
    const mockQuote = { id: mockQuoteId, invoiceId: null, amount: 100 }
    vi.mocked(prisma.quote.findFirst).mockResolvedValue(mockQuote as never)

    const res = await PATCH(
      makeRequest('PATCH', {
        lineItems: [{ id: 'item-1', unitPrice: -10 }],
      }),
      { params },
    )
    expect(res.status).toBe(400)
  })

  it('rejects updates to a converted quote', async () => {
    const mockQuote = { id: mockQuoteId, invoiceId: 'invoice-123', amount: 100 }
    vi.mocked(prisma.quote.findFirst).mockResolvedValue(mockQuote as never)

    const res = await PATCH(
      makeRequest('PATCH', {
        lineItems: [{ id: 'item-1', description: 'Updated' }],
      }),
      { params },
    )
    expect(res.status).toBe(409)
  })
})

describe('DELETE /api/quotes/[id]/line-items', () => {
  it('deletes multiple line items', async () => {
    const mockQuote = { id: mockQuoteId, invoiceId: null, amount: 100 }
    vi.mocked(prisma.quote.findFirst).mockResolvedValue(mockQuote as never)
    vi.mocked(prisma.quoteLineItem.deleteMany).mockResolvedValue({ count: 1 } as never)
    vi.mocked(prisma.quote.update).mockResolvedValue(mockQuote as never)

    const mockLineItems = []
    vi.mocked(prisma.quoteLineItem.findMany).mockResolvedValue(mockLineItems as never)

    const res = await DELETE(makeRequest('DELETE', { ids: ['item-1'] }), { params })
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.lineItems).toHaveLength(0)
    expect(prisma.quoteLineItem.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['item-1'] }, quoteId: mockQuoteId },
    })
  })

  it('rejects deletion from a converted quote', async () => {
    const mockQuote = { id: mockQuoteId, invoiceId: 'invoice-123', amount: 100 }
    vi.mocked(prisma.quote.findFirst).mockResolvedValue(mockQuote as never)

    const res = await DELETE(makeRequest('DELETE', { ids: ['item-1'] }), { params })
    expect(res.status).toBe(409)
  })

  it('returns 400 when ids array is empty', async () => {
    const mockQuote = { id: mockQuoteId, invoiceId: null, amount: 100 }
    vi.mocked(prisma.quote.findFirst).mockResolvedValue(mockQuote as never)

    const res = await DELETE(makeRequest('DELETE', { ids: [] }), { params })
    expect(res.status).toBe(400)
  })

  it('returns 401 when no auth token provided', async () => {
    const request = new NextRequest(`http://localhost:3000/api/quotes/${mockQuoteId}/line-items`, {
      method: 'DELETE',
      body: JSON.stringify({ ids: ['item-1'] }),
    })
    const res = await DELETE(request, { params })
    expect(res.status).toBe(401)
  })
})
