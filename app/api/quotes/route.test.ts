import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GET, POST } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    quote: {
      count: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'

function makeRequest(
  method: string = 'GET',
  token: string | null = 'valid-token',
  body?: Record<string, unknown>,
): NextRequest {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (token) headers.set('authorization', `Bearer ${token}`)

  return new NextRequest('http://localhost/api/quotes', {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/quotes', () => {
  describe('Authentication', () => {
    it('returns 401 when not authenticated', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue(null)

      const res = await GET(makeRequest('GET', null))
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('Unauthorized')
    })

    it('returns 404 when user not found', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_unknown' })
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null)

      const res = await GET(makeRequest('GET'))
      expect(res.status).toBe(404)
    })
  })

  describe('Query parameters', () => {
    beforeEach(() => {
      vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_1' })
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user_1' })
    })

    it('rejects invalid status parameter', async () => {
      vi.mocked(prisma.quote.count).mockResolvedValue(0)

      const req = new NextRequest('http://localhost/api/quotes?status=invalid', {
        method: 'GET',
        headers: { authorization: 'Bearer token' },
      })

      const res = await GET(req)
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('Invalid status')
    })

    it('returns empty list when no quotes exist', async () => {
      vi.mocked(prisma.quote.count).mockResolvedValue(0)
      vi.mocked(prisma.quote.findMany).mockResolvedValue([])

      const res = await GET(makeRequest('GET'))
      expect(res.status).toBe(200)
      const body = await res.json()

      expect(body.quotes).toEqual([])
      expect(body.pagination.total).toBe(0)
    })
  })

  describe('Listing quotes', () => {
    beforeEach(() => {
      vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_1' })
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user_1' })
    })

    it('returns quotes with line items', async () => {
      const createdAt = new Date('2026-01-01')
      vi.mocked(prisma.quote.count).mockResolvedValue(1)
      vi.mocked(prisma.quote.findMany).mockResolvedValue([
        {
          id: 'quote_1',
          clientEmail: 'client@example.com',
          clientName: 'John Doe',
          description: 'Project quote',
          amount: 1000,
          currency: 'USD',
          status: 'draft',
          expiresAt: null,
          createdAt,
          lineItems: [
            {
              id: 'line_1',
              description: 'Service',
              quantity: 10,
              unitPrice: 100,
              position: 0,
            },
          ],
        },
      ])

      const res = await GET(makeRequest('GET'))
      expect(res.status).toBe(200)
      const body = await res.json()

      expect(body.quotes).toHaveLength(1)
      expect(body.quotes[0].id).toBe('quote_1')
      expect(body.quotes[0].lineItems).toHaveLength(1)
      expect(body.quotes[0].amount).toBe(1000)
    })
  })
})

describe('POST /api/quotes', () => {
  describe('Authentication', () => {
    it('returns 401 when not authenticated', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue(null)

      const res = await POST(makeRequest('POST', null, {}))
      expect(res.status).toBe(401)
    })

    it('returns 404 when user not found', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_unknown' })
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null)

      const res = await POST(makeRequest('POST', 'token', {}))
      expect(res.status).toBe(404)
    })
  })

  describe('Request validation', () => {
    beforeEach(() => {
      vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_1' })
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user_1' })
    })

    it('rejects invalid JSON', async () => {
      const req = new NextRequest('http://localhost/api/quotes', {
        method: 'POST',
        headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
        body: 'not json',
      })

      const res = await POST(req)
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('Invalid JSON')
    })

    it('rejects missing clientEmail', async () => {
      const res = await POST(
        makeRequest('POST', 'token', {
          lineItems: [{ description: 'Item', quantity: 1, unitPrice: 100 }],
        }),
      )

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('clientEmail')
    })

    it('rejects invalid email address', async () => {
      const res = await POST(
        makeRequest('POST', 'token', {
          clientEmail: 'not-an-email',
          lineItems: [{ description: 'Item', quantity: 1, unitPrice: 100 }],
        }),
      )

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('valid email')
    })

    it('rejects missing line items', async () => {
      const res = await POST(
        makeRequest('POST', 'token', {
          clientEmail: 'client@example.com',
        }),
      )

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('At least one line item')
    })

    it('rejects empty line items array', async () => {
      const res = await POST(
        makeRequest('POST', 'token', {
          clientEmail: 'client@example.com',
          lineItems: [],
        }),
      )

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('At least one line item')
    })

    it('rejects line item without description', async () => {
      const res = await POST(
        makeRequest('POST', 'token', {
          clientEmail: 'client@example.com',
          lineItems: [{ quantity: 1, unitPrice: 100 }],
        }),
      )

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('description')
    })

    it('rejects line item with invalid quantity', async () => {
      const res = await POST(
        makeRequest('POST', 'token', {
          clientEmail: 'client@example.com',
          lineItems: [{ description: 'Item', quantity: -1, unitPrice: 100 }],
        }),
      )

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('quantity')
    })

    it('rejects line item with invalid unitPrice', async () => {
      const res = await POST(
        makeRequest('POST', 'token', {
          clientEmail: 'client@example.com',
          lineItems: [{ description: 'Item', quantity: 1, unitPrice: 'not-a-number' }],
        }),
      )

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('unitPrice')
    })

    it('rejects quote with zero total amount', async () => {
      const res = await POST(
        makeRequest('POST', 'token', {
          clientEmail: 'client@example.com',
          lineItems: [{ description: 'Item', quantity: 1, unitPrice: 0 }],
        }),
      )

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('total must be greater than zero')
    })

    it('rejects invalid expiresAt date', async () => {
      const res = await POST(
        makeRequest('POST', 'token', {
          clientEmail: 'client@example.com',
          expiresAt: 'invalid-date',
          lineItems: [{ description: 'Item', quantity: 1, unitPrice: 100 }],
        }),
      )

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('valid date')
    })
  })

  describe('Quote creation', () => {
    beforeEach(() => {
      vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_1' })
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user_1' })
    })

    it('computes total from line items', async () => {
      const createdAt = new Date('2026-01-01')
      vi.mocked(prisma.quote.create).mockResolvedValue({
        id: 'quote_1',
        clientEmail: 'client@example.com',
        clientName: 'John Doe',
        description: 'Project',
        amount: 1500, // 10 * 100 + 5 * 100
        currency: 'USD',
        status: 'draft',
        expiresAt: null,
        createdAt,
        lineItems: [
          {
            id: 'line_1',
            description: 'Service 1',
            quantity: 10,
            unitPrice: 100,
            position: 0,
          },
          {
            id: 'line_2',
            description: 'Service 2',
            quantity: 5,
            unitPrice: 100,
            position: 1,
          },
        ],
      })

      const res = await POST(
        makeRequest('POST', 'token', {
          clientEmail: 'client@example.com',
          clientName: 'John Doe',
          description: 'Project',
          lineItems: [
            { description: 'Service 1', quantity: 10, unitPrice: 100 },
            { description: 'Service 2', quantity: 5, unitPrice: 100 },
          ],
        }),
      )

      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.amount).toBe(1500)

      // Verify create was called with correct total
      const createCall = vi.mocked(prisma.quote.create).mock.calls[0][0]
      expect(createCall.data.amount).toBe(1500)
    })

    it('defaults status to draft', async () => {
      vi.mocked(prisma.quote.create).mockResolvedValue({
        id: 'quote_1',
        clientEmail: 'client@example.com',
        clientName: null,
        description: '',
        amount: 100,
        currency: 'USD',
        status: 'draft',
        expiresAt: null,
        createdAt: new Date(),
        lineItems: [
          { id: 'line_1', description: 'Item', quantity: 1, unitPrice: 100, position: 0 },
        ],
      })

      const res = await POST(
        makeRequest('POST', 'token', {
          clientEmail: 'client@example.com',
          lineItems: [{ description: 'Item', quantity: 1, unitPrice: 100 }],
        }),
      )

      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.status).toBe('draft')
    })

    it('accepts clientEmail and line items, computes total', async () => {
      const expiresAt = new Date('2026-02-01')
      vi.mocked(prisma.quote.create).mockResolvedValue({
        id: 'quote_1',
        clientEmail: 'client@example.com',
        clientName: 'Jane Doe',
        description: 'Services',
        amount: 500,
        currency: 'USD',
        status: 'draft',
        expiresAt,
        createdAt: new Date(),
        lineItems: [
          { id: 'line_1', description: 'Consulting', quantity: 5, unitPrice: 100, position: 0 },
        ],
      })

      const res = await POST(
        makeRequest('POST', 'token', {
          clientEmail: 'client@example.com',
          clientName: 'Jane Doe',
          description: 'Services',
          expiresAt: expiresAt.toISOString(),
          lineItems: [{ description: 'Consulting', quantity: 5, unitPrice: 100 }],
        }),
      )

      expect(res.status).toBe(201)
      const body = await res.json()

      expect(body.clientEmail).toBe('client@example.com')
      expect(body.clientName).toBe('Jane Doe')
      expect(body.amount).toBe(500)
      expect(body.status).toBe('draft')
    })

    it('normalizes clientEmail to lowercase', async () => {
      vi.mocked(prisma.quote.create).mockResolvedValue({
        id: 'quote_1',
        clientEmail: 'client@example.com',
        clientName: null,
        description: '',
        amount: 100,
        currency: 'USD',
        status: 'draft',
        expiresAt: null,
        createdAt: new Date(),
        lineItems: [
          { id: 'line_1', description: 'Item', quantity: 1, unitPrice: 100, position: 0 },
        ],
      })

      const res = await POST(
        makeRequest('POST', 'token', {
          clientEmail: 'CLIENT@EXAMPLE.COM',
          lineItems: [{ description: 'Item', quantity: 1, unitPrice: 100 }],
        }),
      )

      const createCall = vi.mocked(prisma.quote.create).mock.calls[0][0]
      expect(createCall.data.clientEmail).toBe('client@example.com')
    })

    it('defaults currency to USD', async () => {
      vi.mocked(prisma.quote.create).mockResolvedValue({
        id: 'quote_1',
        clientEmail: 'client@example.com',
        clientName: null,
        description: '',
        amount: 100,
        currency: 'USD',
        status: 'draft',
        expiresAt: null,
        createdAt: new Date(),
        lineItems: [
          { id: 'line_1', description: 'Item', quantity: 1, unitPrice: 100, position: 0 },
        ],
      })

      const res = await POST(
        makeRequest('POST', 'token', {
          clientEmail: 'client@example.com',
          lineItems: [{ description: 'Item', quantity: 1, unitPrice: 100 }],
        }),
      )

      const createCall = vi.mocked(prisma.quote.create).mock.calls[0][0]
      expect(createCall.data.currency).toBe('USD')
    })

    it('returns 201 on successful creation', async () => {
      vi.mocked(prisma.quote.create).mockResolvedValue({
        id: 'quote_1',
        clientEmail: 'client@example.com',
        clientName: null,
        description: '',
        amount: 100,
        currency: 'USD',
        status: 'draft',
        expiresAt: null,
        createdAt: new Date(),
        lineItems: [
          { id: 'line_1', description: 'Item', quantity: 1, unitPrice: 100, position: 0 },
        ],
      })

      const res = await POST(
        makeRequest('POST', 'token', {
          clientEmail: 'client@example.com',
          lineItems: [{ description: 'Item', quantity: 1, unitPrice: 100 }],
        }),
      )

      expect(res.status).toBe(201)
    })
  })

  describe('Error handling', () => {
    beforeEach(() => {
      vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_1' })
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user_1' })
    })

    it('returns 500 on database error', async () => {
      vi.mocked(prisma.quote.create).mockRejectedValue(new Error('DB error'))

      const res = await POST(
        makeRequest('POST', 'token', {
          clientEmail: 'client@example.com',
          lineItems: [{ description: 'Item', quantity: 1, unitPrice: 100 }],
        }),
      )

      expect(res.status).toBe(500)
      const body = await res.json()
      expect(body.error).toContain('Failed to create quote')
    })
  })

  describe('Happy path scenarios', () => {
    it('creates quote with single line item', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_1' })
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user_1' })

      const createdAt = new Date()
      vi.mocked(prisma.quote.create).mockResolvedValue({
        id: 'quote_1',
        clientEmail: 'client@example.com',
        clientName: 'John',
        description: 'Web design',
        amount: 5000,
        currency: 'USD',
        status: 'draft',
        expiresAt: null,
        createdAt,
        lineItems: [
          { id: 'line_1', description: 'Web Design', quantity: 40, unitPrice: 125, position: 0 },
        ],
      })

      const res = await POST(
        makeRequest('POST', 'token', {
          clientEmail: 'client@example.com',
          clientName: 'John',
          description: 'Web design',
          lineItems: [{ description: 'Web Design', quantity: 40, unitPrice: 125 }],
        }),
      )

      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.amount).toBe(5000)
      expect(body.lineItems).toHaveLength(1)
    })

    it('creates quote with multiple line items', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy_1' })
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user_1' })

      vi.mocked(prisma.quote.create).mockResolvedValue({
        id: 'quote_1',
        clientEmail: 'client@example.com',
        clientName: 'Jane',
        description: 'Project',
        amount: 4500,
        currency: 'EUR',
        status: 'draft',
        expiresAt: new Date('2026-02-01'),
        createdAt: new Date(),
        lineItems: [
          { id: 'line_1', description: 'Design', quantity: 20, unitPrice: 100, position: 0 },
          { id: 'line_2', description: 'Development', quantity: 25, unitPrice: 100, position: 1 },
          { id: 'line_3', description: 'Testing', quantity: 10, unitPrice: 50, position: 2 },
        ],
      })

      const res = await POST(
        makeRequest('POST', 'token', {
          clientEmail: 'client@example.com',
          clientName: 'Jane',
          description: 'Project',
          currency: 'EUR',
          expiresAt: '2026-02-01',
          lineItems: [
            { description: 'Design', quantity: 20, unitPrice: 100 },
            { description: 'Development', quantity: 25, unitPrice: 100 },
            { description: 'Testing', quantity: 10, unitPrice: 50 },
          ],
        }),
      )

      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.amount).toBe(4500)
      expect(body.lineItems).toHaveLength(3)
      expect(body.currency).toBe('EUR')
    })
  })
})
