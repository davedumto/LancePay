import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST } from '@/app/api/invoices/route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { generateInvoiceNumber } from '@/lib/utils'
import { sendInvoiceToClient } from '@/lib/email'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { create: vi.fn() },
  },
}))

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/utils', () => ({
  generateInvoiceNumber: vi.fn(),
}))

vi.mock('@/lib/email', () => ({
  sendInvoiceToClient: vi.fn().mockResolvedValue({ success: true }),
}))

const mockUser = {
  id: 'user-1',
  email: 'freelancer@example.com',
  name: 'Alice Freelancer',
}

const mockInvoice = {
  id: 'inv-1',
  invoiceNumber: 'INV-001',
  clientEmail: 'client@example.com',
  clientName: 'Bob Client',
  amount: 500,
  currency: 'USD',
  paymentLink: 'https://example.com/pay/INV-001',
  status: 'pending',
  dueDate: null,
}

function makeRequest(body: object, token = 'Bearer valid-token') {
  return new Request('http://localhost/api/invoices', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: token },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest
}

describe('POST /api/invoices', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as never)
    vi.mocked(generateInvoiceNumber).mockReturnValue('INV-001')
    vi.mocked(prisma.invoice.create).mockResolvedValue(mockInvoice as never)
    process.env.NEXT_PUBLIC_APP_URL = 'https://example.com'
  })

  it('calls sendInvoiceToClient with correct params on success', async () => {
    const res = await POST(makeRequest({
      clientEmail: 'client@example.com',
      clientName: 'Bob Client',
      description: 'Web development',
      amount: 500,
      currency: 'USD',
    }))

    expect(res.status).toBe(201)
    expect(sendInvoiceToClient).toHaveBeenCalledOnce()
    expect(sendInvoiceToClient).toHaveBeenCalledWith({
      clientEmail: 'client@example.com',
      clientName: 'Bob Client',
      freelancerName: 'Alice Freelancer',
      invoiceNumber: 'INV-001',
      amount: 500,
      currency: 'USD',
      dueDate: null,
      paymentLink: 'https://example.com/pay/INV-001',
    })
  })

  it('returns 201 even when sendInvoiceToClient rejects', async () => {
    vi.mocked(sendInvoiceToClient).mockRejectedValue(new Error('SMTP failure'))

    const res = await POST(makeRequest({
      clientEmail: 'client@example.com',
      clientName: null,
      description: 'Design work',
      amount: 200,
      currency: 'USD',
    }))

    expect(res.status).toBe(201)
  })

  it('does not call sendInvoiceToClient when auth fails', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null as never)

    const res = await POST(makeRequest({
      clientEmail: 'client@example.com',
      description: 'Work',
      amount: 100,
    }))

    expect(res.status).toBe(401)
    expect(sendInvoiceToClient).not.toHaveBeenCalled()
  })

  it('falls back to user.email for freelancerName when name is null', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ ...mockUser, name: null } as never)

    await POST(makeRequest({
      clientEmail: 'client@example.com',
      clientName: 'Bob',
      description: 'Consulting',
      amount: 300,
    }))

    expect(sendInvoiceToClient).toHaveBeenCalledWith(
      expect.objectContaining({ freelancerName: 'freelancer@example.com' }),
    )
  })

  it.each([
    ['a non-numeric string', 'abc'],
    ['a numeric string', '500'],
    ['zero', 0],
    ['a negative number', -5],
  ])('returns a clean 400 for %s amount without writing to the database', async (_label, amount) => {
    const res = await POST(makeRequest({
      clientEmail: 'client@example.com',
      description: 'Web development',
      amount,
    }))

    expect(res.status).toBe(400)
    expect(prisma.invoice.create).not.toHaveBeenCalled()
    expect(sendInvoiceToClient).not.toHaveBeenCalled()
  })

  describe('createInvoiceSchema validation', () => {
    const validBody = {
      clientEmail: 'client@example.com',
      description: 'Web development',
      amount: 500,
    }

    it('rejects a missing required field with the schema-derived error', async () => {
      const res = await POST(makeRequest({
        clientEmail: validBody.clientEmail,
        amount: validBody.amount,
      }))
      const json = await res.json()

      expect(res.status).toBe(400)
      expect(json.error).toBe('Invalid request body')
      expect(json.details.description).toEqual(['Required'])
      expect(prisma.invoice.create).not.toHaveBeenCalled()
    })

    it.each([
      ['clientEmail', { clientEmail: 'not-an-email' }],
      ['amount', { amount: 'abc' }],
      ['amount', { amount: 100001 }],
      ['currency', { currency: 'dollars' }],
      ['currency', { currency: 'NGN' }],
      ['dueDate', { dueDate: 'not-a-date' }],
    ])('rejects an invalid %s', async (field, override) => {
      const res = await POST(makeRequest({ ...validBody, ...override }))
      const json = await res.json()

      expect(res.status).toBe(400)
      expect(json.details[field]).toBeDefined()
      expect(prisma.invoice.create).not.toHaveBeenCalled()
      expect(sendInvoiceToClient).not.toHaveBeenCalled()
    })

    it('defaults currency to USD and accepts the empty optional fields the form sends', async () => {
      const res = await POST(makeRequest({ ...validBody, clientName: '', dueDate: '' }))

      expect(res.status).toBe(201)
      expect(prisma.invoice.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ currency: 'USD', clientName: null, dueDate: null }),
      })
    })

    it('returns 400 for a malformed JSON body', async () => {
      const req = new Request('http://localhost/api/invoices', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer valid-token' },
        body: '{not json',
      }) as unknown as import('next/server').NextRequest

      const res = await POST(req)

      expect(res.status).toBe(400)
      expect(prisma.invoice.create).not.toHaveBeenCalled()
    })
  })
})
