import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '../route'

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

import { verifyAuthToken } from '@/lib/auth'
import { generateInvoiceNumber } from '@/lib/utils'
import { prisma } from '@/lib/db'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedGenerateInvoiceNumber = vi.mocked(generateInvoiceNumber)
const mockedUserFindUnique = vi.mocked(prisma.user.findUnique)
const mockedInvoiceFindUnique = vi.mocked(prisma.invoice.findUnique)
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
}

function makeRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { authorization: 'Bearer token' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/routes-b/invoices duplicate detection', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFindUnique.mockResolvedValue(fakeUser as never)
    mockedInvoiceFindUnique.mockResolvedValue(null as never)
    mockedGenerateInvoiceNumber.mockReturnValue('INV-123')
    mockedInvoiceCreate.mockResolvedValue(fakeInvoice as never)
  })

  it('creates invoice when there is no duplicate', async () => {
    mockedInvoiceFindFirst.mockResolvedValue(null as never)
    const req = makeRequest('http://localhost/api/routes-b/invoices', {
      clientEmail: 'client@example.com',
      description: 'Website redesign',
      amount: 100,
      currency: 'usd',
    })

    const res = await POST(req)

    expect(res.status).toBe(201)
    expect(mockedInvoiceFindFirst).toHaveBeenCalled()
    expect(mockedInvoiceCreate).toHaveBeenCalled()
  })

  it('blocks near-duplicate with 409', async () => {
    mockedInvoiceFindFirst.mockResolvedValue({ id: 'existing-invoice' } as never)
    const req = makeRequest('http://localhost/api/routes-b/invoices', {
      clientEmail: 'client@example.com',
      description: 'Website redesign',
      amount: 100,
      currency: 'USD',
    })

    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body).toEqual({ duplicateOfId: 'existing-invoice' })
    expect(mockedInvoiceCreate).not.toHaveBeenCalled()
  })

  it('bypasses duplicate check when force=true', async () => {
    const req = makeRequest('http://localhost/api/routes-b/invoices?force=true', {
      clientEmail: 'client@example.com',
      description: 'Website redesign',
      amount: 100,
      currency: 'USD',
    })

    const res = await POST(req)

    expect(res.status).toBe(201)
    expect(mockedInvoiceFindFirst).not.toHaveBeenCalled()
    expect(mockedInvoiceCreate).toHaveBeenCalled()
  })

  it('allows create when similar invoice is outside duplicate window', async () => {
    mockedInvoiceFindFirst.mockResolvedValue(null as never)
    const req = makeRequest('http://localhost/api/routes-b/invoices', {
      clientEmail: 'client@example.com',
      description: 'Website redesign',
      amount: 100,
      currency: 'USD',
    })

    const res = await POST(req)

    expect(res.status).toBe(201)
    expect(mockedInvoiceFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: expect.objectContaining({ gte: expect.any(Date) }),
        }),
      }),
    )
  })
})

