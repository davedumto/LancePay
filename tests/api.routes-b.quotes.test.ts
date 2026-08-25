import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const invoiceCount = vi.fn()
const invoiceFindMany = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    invoice: { count: invoiceCount, findMany: invoiceFindMany },
  },
}))

const BASE_URL = 'http://localhost/api/routes-b/quotes'

function makeRequest(method: string, body?: unknown, searchParams?: string) {
  const url = searchParams ? `${BASE_URL}?${searchParams}` : BASE_URL
  return new NextRequest(url, {
    method,
    headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

describe('GET /api/routes-b/quotes', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 for unauthenticated requests', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-b/quotes/route')
    const res = await GET(makeRequest('GET'))
    expect(res.status).toBe(401)
  })

  it('returns 404 when user is not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-b/quotes/route')
    const res = await GET(makeRequest('GET'))
    expect(res.status).toBe(404)
  })

  it('returns 400 for invalid status', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { GET } = await import('@/app/api/routes-b/quotes/route')
    const res = await GET(makeRequest('GET', undefined, 'status=invalid_status'))
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'Invalid status' })
  })

  it('returns quotes list and pagination data', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceCount.mockResolvedValue(1)
    invoiceFindMany.mockResolvedValue([
      {
        id: 'inv_1',
        invoiceNumber: 'INV-100',
        clientName: 'Alice',
        clientEmail: 'alice@example.com',
        description: 'Web Design Quote',
        amount: 1200,
        currency: 'USD',
        status: 'draft',
        dueDate: new Date('2026-12-31'),
        createdAt: new Date('2026-08-25'),
      },
    ])

    const { GET } = await import('@/app/api/routes-b/quotes/route')
    const res = await GET(makeRequest('GET'))
    expect(res.status).toBe(200)

    const data = await res.json()
    expect(data.quotes.length).toBe(1)
    expect(data.quotes[0].quoteNumber).toBe('QTE-100')
    expect(data.quotes[0].amount).toBe(1200)
    expect(data.pagination.total).toBe(1)
  })
})

describe('POST /api/routes-b/quotes', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 for unauthenticated requests', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-b/quotes/route')
    const res = await POST(makeRequest('POST', { clientEmail: 'test@example.com', description: 'Test', amount: 100 }))
    expect(res.status).toBe(401)
  })

  it('returns 400 when required fields are missing', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { POST } = await import('@/app/api/routes-b/quotes/route')
    const res = await POST(makeRequest('POST', { clientEmail: 'test@example.com' }))
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'clientEmail, description, and amount are required' })
  })

  it('returns 400 for invalid client email', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { POST } = await import('@/app/api/routes-b/quotes/route')
    const res = await POST(makeRequest('POST', { clientEmail: 'not-an-email', description: 'Test', amount: 100 }))
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'clientEmail must be a valid email address' })
  })

  it('returns 400 for non-positive amount', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { POST } = await import('@/app/api/routes-b/quotes/route')
    const res = await POST(makeRequest('POST', { clientEmail: 'client@example.com', description: 'Test', amount: -50 }))
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'amount must be a positive number' })
  })

  it('creates quote successfully and returns 201', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    const { POST } = await import('@/app/api/routes-b/quotes/route')
    const payload = {
      clientEmail: 'client@example.com',
      clientName: 'Acme Corp',
      description: 'Logo Design',
      amount: 450,
      currency: 'USD',
      validUntil: '2026-12-31T00:00:00.000Z',
    }
    const res = await POST(makeRequest('POST', payload))
    expect(res.status).toBe(201)

    const json = await res.json()
    expect(json.clientEmail).toBe('client@example.com')
    expect(json.clientName).toBe('Acme Corp')
    expect(json.amount).toBe(450)
    expect(json.status).toBe('draft')
  })
})
