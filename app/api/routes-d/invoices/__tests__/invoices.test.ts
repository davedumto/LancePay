import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { findMany: vi.fn(), create: vi.fn() },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))
vi.mock('@/lib/utils', () => ({ generateInvoiceNumber: vi.fn(() => 'INV-TEST-0001') }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET, POST } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedInvoiceFindMany = vi.mocked(prisma.invoice.findMany)
const mockedInvoiceCreate = vi.mocked(prisma.invoice.create)

function makeRequest(method: string, url: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
  mockedUserFind.mockResolvedValue({ id: 'user-1' } as never)
})

/* ──────────────── GET ──────────────── */

describe('GET /api/routes-d/invoices', () => {
  it('returns 401 when no token', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const req = new NextRequest('http://localhost/api/routes-d/invoices', { method: 'GET' })
    expect((await GET(req)).status).toBe(401)
  })

  it('returns 401 when user not found', async () => {
    mockedUserFind.mockResolvedValue(null as never)
    const req = makeRequest('GET', 'http://localhost/api/routes-d/invoices')
    expect((await GET(req)).status).toBe(401)
  })

  it('returns 400 for invalid status filter', async () => {
    const req = makeRequest('GET', 'http://localhost/api/routes-d/invoices?status=invalid')
    expect((await GET(req)).status).toBe(400)
  })

  it('returns paginated invoices', async () => {
    const fakeInvoices = [
      { id: 'inv-1', invoiceNumber: 'INV-A', clientName: 'Alice', clientEmail: 'alice@test.com', amount: 100, currency: 'USD', status: 'pending', dueDate: null, createdAt: new Date() },
    ]
    mockedInvoiceFindMany.mockResolvedValue(fakeInvoices as never)

    const req = makeRequest('GET', 'http://localhost/api/routes-d/invoices')
    const res = await GET(req)
    expect(res.status).toBe(200)

    const json = await res.json()
    expect(json.data).toHaveLength(1)
    expect(json.data[0].id).toBe('inv-1')
    expect(json.nextCursor).toBeNull()
  })

  it('returns nextCursor when more pages exist', async () => {
    const fakeInvoices = Array.from({ length: 21 }, (_, i) => ({
      id: `inv-${i}`,
      invoiceNumber: `INV-${i}`,
      clientName: null,
      clientEmail: `client${i}@test.com`,
      amount: 50,
      currency: 'USD',
      status: 'pending',
      dueDate: null,
      createdAt: new Date(),
    }))
    mockedInvoiceFindMany.mockResolvedValue(fakeInvoices as never)

    const req = makeRequest('GET', 'http://localhost/api/routes-d/invoices')
    const res = await GET(req)
    const json = await res.json()

    expect(json.data).toHaveLength(20)
    expect(json.nextCursor).toBe('inv-19')
  })

  it('filters by status', async () => {
    mockedInvoiceFindMany.mockResolvedValue([] as never)
    const req = makeRequest('GET', 'http://localhost/api/routes-d/invoices?status=paid')
    await GET(req)
    expect(mockedInvoiceFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'paid' }) }),
    )
  })

  it('returns 400 when search query is less than 2 characters', async () => {
    const req = makeRequest('GET', 'http://localhost/api/routes-d/invoices?search=a')
    const res = await GET(req)
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toContain('at least 2 characters')
  })

  it('filters by search query matching clientName, clientEmail, invoiceNumber, description', async () => {
    mockedInvoiceFindMany.mockResolvedValue([] as never)
    const req = makeRequest('GET', 'http://localhost/api/routes-d/invoices?search=test')
    await GET(req)
    expect(mockedInvoiceFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { clientName: { contains: 'test', mode: 'insensitive' } },
            { clientEmail: { contains: 'test', mode: 'insensitive' } },
            { invoiceNumber: { contains: 'test', mode: 'insensitive' } },
            { description: { contains: 'test', mode: 'insensitive' } },
          ],
        }),
      }),
    )
  })
})

/* ──────────────── POST ──────────────── */

describe('POST /api/routes-d/invoices', () => {
  const validBody = {
    clientEmail: 'bob@example.com',
    description: 'Web design work',
    amount: 500,
  }

  const fakeCreated = {
    id: 'inv-new',
    invoiceNumber: 'INV-TEST-0001',
    paymentLink: 'https://app.lancepay.io/pay/INV-TEST-0001',
    status: 'pending',
    amount: 500,
    currency: 'USD',
    clientEmail: 'bob@example.com',
    clientName: null,
    description: 'Web design work',
    dueDate: null,
    createdAt: new Date(),
  }

  it('returns 401 when no token', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const req = new NextRequest('http://localhost/api/routes-d/invoices', {
      method: 'POST',
      body: JSON.stringify(validBody),
    })
    expect((await POST(req)).status).toBe(401)
  })

  it('returns 400 for missing clientEmail', async () => {
    const req = makeRequest('POST', 'http://localhost/api/routes-d/invoices', {
      description: 'Test',
      amount: 100,
    })
    expect((await POST(req)).status).toBe(400)
  })

  it('returns 400 for invalid email', async () => {
    const req = makeRequest('POST', 'http://localhost/api/routes-d/invoices', {
      clientEmail: 'not-an-email',
      description: 'Test',
      amount: 100,
    })
    expect((await POST(req)).status).toBe(400)
  })

  it('returns 400 for missing description', async () => {
    const req = makeRequest('POST', 'http://localhost/api/routes-d/invoices', {
      clientEmail: 'bob@example.com',
      amount: 100,
    })
    expect((await POST(req)).status).toBe(400)
  })

  it('returns 400 for non-positive amount', async () => {
    const req = makeRequest('POST', 'http://localhost/api/routes-d/invoices', {
      ...validBody,
      amount: -10,
    })
    expect((await POST(req)).status).toBe(400)
  })

  it('returns 400 for invalid dueDate', async () => {
    const req = makeRequest('POST', 'http://localhost/api/routes-d/invoices', {
      ...validBody,
      dueDate: 'not-a-date',
    })
    expect((await POST(req)).status).toBe(400)
  })

  it('creates invoice and returns 201', async () => {
    mockedInvoiceCreate.mockResolvedValue(fakeCreated as never)

    const req = makeRequest('POST', 'http://localhost/api/routes-d/invoices', validBody)
    const res = await POST(req)

    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.id).toBe('inv-new')
    expect(json.invoiceNumber).toBe('INV-TEST-0001')
    expect(json.amount).toBe(500)
  })

  it('normalises email to lowercase', async () => {
    mockedInvoiceCreate.mockResolvedValue(fakeCreated as never)

    const req = makeRequest('POST', 'http://localhost/api/routes-d/invoices', {
      ...validBody,
      clientEmail: 'BOB@EXAMPLE.COM',
    })
    await POST(req)

    expect(mockedInvoiceCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ clientEmail: 'bob@example.com' }),
      }),
    )
  })
})
