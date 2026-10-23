import { describe, it, expect, beforeEach, vi } from 'vitest'
import { GET, POST } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoiceTemplate: { findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUserId = 'user-123'
const mockPrivyId = 'privy-123'

function makeRequest(method: 'GET' | 'POST', body?: Record<string, unknown>, url?: string) {
  return new NextRequest(url || 'http://localhost:3000/api/invoice-templates', {
    method,
    headers: { Authorization: 'Bearer valid-token' },
    body: body ? JSON.stringify(body) : undefined,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: mockPrivyId } as { userId: string })
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: mockUserId } as never)
})

describe('GET /api/invoice-templates', () => {
  it('returns the user invoice templates', async () => {
    const mockTemplates = [
      {
        id: 'template-1',
        name: 'Web Development',
        clientEmail: 'client@example.com',
        clientName: 'Acme Corp',
        description: 'Website development services',
        amount: 5000,
        currency: 'USD',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]
    vi.mocked(prisma.invoiceTemplate.findMany).mockResolvedValue(mockTemplates as never)

    const res = await GET(makeRequest('GET'))
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.templates).toHaveLength(1)
    expect(data.templates[0].name).toBe('Web Development')
  })

  it('instantiates a new invoice from a template when instantiateFrom is provided', async () => {
    const mockTemplate = {
      id: 'template-1',
      name: 'Web Development',
      clientEmail: 'client@example.com',
      clientName: 'Acme Corp',
      description: 'Website development services',
      amount: 5000,
      currency: 'USD',
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    vi.mocked(prisma.invoiceTemplate.findFirst).mockResolvedValue(mockTemplate as never)

    const res = await GET(makeRequest('GET', null, 'http://localhost:3000/api/invoice-templates?instantiateFrom=template-1'))
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.invoice.clientEmail).toBe('client@example.com')
    expect(data.invoice.amount).toBe(5000)
  })

  it('returns 404 when template to instantiate from does not exist', async () => {
    vi.mocked(prisma.invoiceTemplate.findFirst).mockResolvedValue(null)

    const res = await GET(makeRequest('GET', null, 'http://localhost:3000/api/invoice-templates?instantiateFrom=nonexistent'))
    expect(res.status).toBe(404)
  })

  it('returns 401 when no auth token provided', async () => {
    const request = new NextRequest('http://localhost:3000/api/invoice-templates')
    const res = await GET(request)
    expect(res.status).toBe(401)
  })

  it('returns 500 on database error', async () => {
    vi.mocked(prisma.invoiceTemplate.findMany).mockRejectedValue(new Error('Database error'))
    const res = await GET(makeRequest('GET'))
    expect(res.status).toBe(500)
  })
})

describe('POST /api/invoice-templates', () => {
  it('creates a new invoice template', async () => {
    const mockTemplate = {
      id: 'template-1',
      name: 'Web Development',
      clientEmail: 'client@example.com',
      clientName: 'Acme Corp',
      description: 'Website development services',
      amount: 5000,
      currency: 'USD',
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    vi.mocked(prisma.invoiceTemplate.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.invoiceTemplate.create).mockResolvedValue(mockTemplate as never)

    const res = await POST(
      makeRequest('POST', {
        name: 'Web Development',
        clientEmail: 'client@example.com',
        clientName: 'Acme Corp',
        description: 'Website development services',
        amount: 5000,
        currency: 'USD',
      }),
    )
    const data = await res.json()

    expect(res.status).toBe(201)
    expect(data.template.name).toBe('Web Development')
    expect(prisma.invoiceTemplate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: mockUserId,
        name: 'Web Development',
        amount: 5000,
        currency: 'USD',
      }),
      select: expect.any(Object),
    })
  })

  it('returns 409 when template name already exists', async () => {
    vi.mocked(prisma.invoiceTemplate.findUnique).mockResolvedValue({ id: 'existing' } as never)

    const res = await POST(
      makeRequest('POST', {
        name: 'Web Development',
        description: 'Website development services',
        amount: 5000,
      }),
    )
    expect(res.status).toBe(409)
  })

  it('rejects non-positive amount', async () => {
    const res = await POST(
      makeRequest('POST', {
        name: 'Web Development',
        description: 'Website development services',
        amount: -100,
      }),
    )
    expect(res.status).toBe(400)
  })

  it('rejects invalid currency', async () => {
    const res = await POST(
      makeRequest('POST', {
        name: 'Web Development',
        description: 'Website development services',
        amount: 5000,
        currency: 'INVALID',
      }),
    )
    expect(res.status).toBe(400)
  })

  it('defaults to USD when currency not provided', async () => {
    const mockTemplate = {
      id: 'template-1',
      name: 'Web Development',
      clientEmail: null,
      clientName: null,
      description: 'Website development services',
      amount: 5000,
      currency: 'USD',
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    vi.mocked(prisma.invoiceTemplate.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.invoiceTemplate.create).mockResolvedValue(mockTemplate as never)

    const res = await POST(
      makeRequest('POST', {
        name: 'Web Development',
        description: 'Website development services',
        amount: 5000,
      }),
    )
    const data = await res.json()

    expect(res.status).toBe(201)
    expect(data.template.currency).toBe('USD')
  })

  it('returns 401 when no auth token provided', async () => {
    const request = new NextRequest('http://localhost:3000/api/invoice-templates', {
      method: 'POST',
      body: JSON.stringify({ name: 'Test', description: 'Test', amount: 100 }),
    })
    const res = await POST(request)
    expect(res.status).toBe(401)
  })

  it('returns 400 when name is missing', async () => {
    const res = await POST(
      makeRequest('POST', {
        description: 'Website development services',
        amount: 5000,
      }),
    )
    expect(res.status).toBe(400)
  })

  it('returns 400 when description is missing', async () => {
    const res = await POST(
      makeRequest('POST', {
        name: 'Web Development',
        amount: 5000,
      }),
    )
    expect(res.status).toBe(400)
  })

  it('returns 500 on database error', async () => {
    vi.mocked(prisma.invoiceTemplate.create).mockRejectedValue(new Error('Database error'))
    const res = await POST(
      makeRequest('POST', {
        name: 'Web Development',
        description: 'Website development services',
        amount: 5000,
      }),
    )
    expect(res.status).toBe(500)
  })
})
