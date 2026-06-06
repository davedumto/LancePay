import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/utils', () => ({
  generateInvoiceNumber: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
    invoice: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  },
}))

vi.mock('../../_lib/invoice-archive', () => ({
  parseIncludeArchivedParam: vi.fn(() => false),
  getArchiveFilter: vi.fn(() => ({})),
}))

vi.mock('../../_lib/invoice-filters', () => ({
  buildInvoiceWhereFilters: vi.fn(() => ({})),
}))

vi.mock('../../_lib/events', () => ({
  emitStatsInvalidated: vi.fn(),
}))

import { verifyAuthToken } from '@/lib/auth'
import { generateInvoiceNumber } from '@/lib/utils'
import { prisma } from '@/lib/db'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedGenerateInvoiceNumber = vi.mocked(generateInvoiceNumber)
const mockedUserFindUnique = vi.mocked(prisma.user.findUnique)
const mockedInvoiceFindFirst = vi.mocked(prisma.invoice.findFirst)
const mockedInvoiceCreate = vi.mocked(prisma.invoice.create)

const fakeUser = { id: 'user-1', privyId: 'privy-1' }
const fakeInvoice = {
  id: 'invoice-123',
  invoiceNumber: 'INV-123',
  paymentLink: 'https://example.com/pay/INV-123',
  status: 'pending',
  amount: 100,
  currency: 'USD',
  createdAt: new Date('2024-01-01'),
}

function makeRequest(url: string, body: unknown, idempotencyKey?: string): NextRequest {
  const headers = idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}
  return new NextRequest(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }) as any
}

describe('invoices POST idempotency', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFindUnique.mockResolvedValue(fakeUser as never)
    mockedInvoiceFindFirst.mockResolvedValue(null as never)
    mockedGenerateInvoiceNumber.mockReturnValue('INV-123')
    mockedInvoiceCreate.mockResolvedValue(fakeInvoice as never)
  })

  it('creates invoice when no idempotency key is provided', async () => {
    const { POST } = await import('../route')
    const req = makeRequest('http://localhost/api/routes-b/invoices', {
      clientEmail: 'client@example.com',
      description: 'Website redesign',
      amount: 100,
    })

    const res = await POST(req)
    expect(res.status).toBe(201)
  })

  it('returns cached response for same idempotency key and body', async () => {
    const { POST } = await import('../route')
    const req1 = makeRequest('http://localhost/api/routes-b/invoices', {
      clientEmail: 'client@example.com',
      description: 'Website redesign',
      amount: 100,
    }, 'key-1')

    const res1 = await POST(req1)
    expect(res1.status).toBe(201)

    const req2 = makeRequest('http://localhost/api/routes-b/invoices', {
      clientEmail: 'client@example.com',
      description: 'Website redesign',
      amount: 100,
    }, 'key-1')

    const res2 = await POST(req2)
    expect(res2.status).toBe(201)
    expect(mockedInvoiceCreate).toHaveBeenCalledTimes(1)
  })

  it('returns 409 for same idempotency key but different body', async () => {
    const { POST } = await import('../route')
    const req1 = makeRequest('http://localhost/api/routes-b/invoices', {
      clientEmail: 'client@example.com',
      description: 'Website redesign',
      amount: 100,
    }, 'key-1')

    await POST(req1)

    const req2 = makeRequest('http://localhost/api/routes-b/invoices', {
      clientEmail: 'client2@example.com',
      description: 'Different invoice',
      amount: 200,
    }, 'key-1')

    const res = await POST(req2)
    expect(res.status).toBe(409)
  })
})