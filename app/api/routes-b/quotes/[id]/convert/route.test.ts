import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from './route'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    quote: { findUnique: vi.fn(), update: vi.fn() },
    invoice: { create: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/utils', () => ({ generateInvoiceNumber: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { generateInvoiceNumber } from '@/lib/utils'

const mockVerify = verifyAuthToken as unknown as ReturnType<typeof vi.fn>
const mockUserFindUnique = prisma.user.findUnique as unknown as ReturnType<typeof vi.fn>
const mockQuoteFindUnique = prisma.quote.findUnique as unknown as ReturnType<typeof vi.fn>
const mockQuoteUpdate = prisma.quote.update as unknown as ReturnType<typeof vi.fn>
const mockInvoiceCreate = prisma.invoice.create as unknown as ReturnType<typeof vi.fn>
const mockGenerateInvoiceNumber = generateInvoiceNumber as unknown as ReturnType<typeof vi.fn>

function makePost(id: string, token: string | null = 'Bearer valid-token') {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = token
  return new NextRequest(`http://localhost/api/routes-b/quotes/${id}/convert`, {
    method: 'POST',
    headers,
  })
}

function callPost(id: string, token: string | null = 'Bearer valid-token') {
  return POST(makePost(id, token), { params: Promise.resolve({ id }) })
}

const mockQuote = {
  id: 'quote-1',
  userId: 'user-1',
  status: 'pending',
  invoiceId: null,
  clientEmail: 'client@example.com',
  clientName: 'Acme Corp',
  description: 'Website redesign',
  amount: { toString: () => '1500' },
  currency: 'USD',
}

beforeEach(() => {
  vi.clearAllMocks()
  mockVerify.mockResolvedValue({ userId: 'privy-1' })
  mockUserFindUnique.mockResolvedValue({ id: 'user-1' })
  mockQuoteFindUnique.mockResolvedValue(mockQuote)
  mockGenerateInvoiceNumber.mockReturnValue('INV-0001')
  // Second call inside the handler looks up the client by email — reuse
  // the same mock (user.findUnique) but it's only asserted generically here.
  mockUserFindUnique.mockImplementation((args: { where: { privyId?: string; email?: string } }) => {
    if (args.where.privyId) return Promise.resolve({ id: 'user-1' })
    return Promise.resolve(null)
  })
  mockInvoiceCreate.mockResolvedValue({
    id: 'inv-new',
    invoiceNumber: 'INV-0001',
    paymentLink: 'https://app.lancepay.test/pay/INV-0001',
    status: 'pending',
  })
  mockQuoteUpdate.mockResolvedValue({ ...mockQuote, status: 'converted' })
})

describe('POST /api/routes-b/quotes/[id]/convert', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await callPost('quote-1', null)
    expect(res.status).toBe(401)
  })

  it('returns 401 when the token is invalid', async () => {
    mockVerify.mockResolvedValue(null)
    const res = await callPost('quote-1')
    expect(res.status).toBe(401)
  })

  it('returns 404 when the user record is missing', async () => {
    mockUserFindUnique.mockResolvedValueOnce(null)
    const res = await callPost('quote-1')
    expect(res.status).toBe(404)
  })

  it('returns 404 when the quote does not exist', async () => {
    mockQuoteFindUnique.mockResolvedValue(null)
    const res = await callPost('missing')
    expect(res.status).toBe(404)
  })

  it('returns 403 when the quote belongs to another user', async () => {
    mockQuoteFindUnique.mockResolvedValue({ ...mockQuote, userId: 'someone-else' })
    const res = await callPost('quote-1')
    expect(res.status).toBe(403)
  })

  it('returns 422 when the quote was already converted', async () => {
    mockQuoteFindUnique.mockResolvedValue({ ...mockQuote, status: 'converted', invoiceId: 'inv-1' })
    const res = await callPost('quote-1')
    expect(res.status).toBe(422)
    expect(mockInvoiceCreate).not.toHaveBeenCalled()
  })

  it('returns 422 when the quote was declined', async () => {
    mockQuoteFindUnique.mockResolvedValue({ ...mockQuote, status: 'declined' })
    const res = await callPost('quote-1')
    expect(res.status).toBe(422)
  })

  it('returns 422 when the quote has expired', async () => {
    mockQuoteFindUnique.mockResolvedValue({ ...mockQuote, status: 'expired' })
    const res = await callPost('quote-1')
    expect(res.status).toBe(422)
  })

  it('creates an invoice, marks the quote converted, and returns 201 on the happy path', async () => {
    const res = await callPost('quote-1')
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.quote.status).toBe('converted')
    expect(json.invoice.invoiceNumber).toBe('INV-0001')

    expect(mockInvoiceCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-1',
          clientEmail: 'client@example.com',
          description: 'Website redesign',
        }),
      }),
    )
    expect(mockQuoteUpdate).toHaveBeenCalledWith({
      where: { id: 'quote-1' },
      data: { status: 'converted', invoiceId: 'inv-new' },
    })
  })

  it('returns 500 when an unexpected error occurs', async () => {
    mockInvoiceCreate.mockRejectedValue(new Error('db unavailable'))
    const res = await callPost('quote-1')
    expect(res.status).toBe(500)
  })
})
