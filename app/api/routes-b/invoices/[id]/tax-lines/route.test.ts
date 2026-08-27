import { describe, it, expect, beforeEach, vi } from 'vitest'
import { GET, POST } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { findFirst: vi.fn() },
    taxRate: { findFirst: vi.fn() },
    invoiceTaxLine: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUserId = 'user-123'
const mockPrivyId = 'privy-123'
const mockInvoiceId = 'inv-456'
const params = { id: mockInvoiceId }

function makeGetRequest(invoiceId = mockInvoiceId, token = 'valid-token') {
  const headers = new Headers()
  if (token) headers.set('authorization', `Bearer ${token}`)
  return new NextRequest(`http://localhost:3000/api/routes-b/invoices/${invoiceId}/tax-lines`, { headers })
}

function makePostRequest(body: unknown, invoiceId = mockInvoiceId, token = 'valid-token') {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (token) headers.set('authorization', `Bearer ${token}`)
  return new NextRequest(`http://localhost:3000/api/routes-b/invoices/${invoiceId}/tax-lines`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

describe('Invoice Tax Lines API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: mockPrivyId } as never)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: mockUserId } as never)
    vi.mocked(prisma.invoice.findFirst).mockResolvedValue({
      id: mockInvoiceId,
      amount: 1000,
      currency: 'USD',
      status: 'pending',
    } as never)
  })

  describe('GET /api/routes-b/invoices/[id]/tax-lines', () => {
    it('returns the list of tax lines on the invoice', async () => {
      const mockTaxLines = [
        {
          id: 'tl-1',
          invoiceId: mockInvoiceId,
          name: 'VAT',
          rate: 10,
          amount: 100,
          taxRateId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]
      vi.mocked(prisma.invoiceTaxLine.findMany).mockResolvedValue(mockTaxLines as never)

      const res = await GET(makeGetRequest(), { params })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.taxLines).toHaveLength(1)
      expect(data.taxLines[0].name).toBe('VAT')
      expect(data.taxLines[0].rate).toBe(10)
    })

    it('returns 401 when unauthorized', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue(null)
      const res = await GET(makeGetRequest(), { params })
      expect(res.status).toBe(401)
      const data = await res.json()
      expect(data.error).toBe('Unauthorized')
    })

    it('returns 404 when invoice is not found', async () => {
      vi.mocked(prisma.invoice.findFirst).mockResolvedValue(null)
      const res = await GET(makeGetRequest(), { params })
      expect(res.status).toBe(404)
      const data = await res.json()
      expect(data.error).toBe('Invoice not found')
    })

    it('returns 500 when database throws an error', async () => {
      vi.mocked(prisma.invoiceTaxLine.findMany).mockRejectedValue(new Error('DB error'))
      const res = await GET(makeGetRequest(), { params })
      expect(res.status).toBe(500)
      const data = await res.json()
      expect(data.error).toBe('Failed to fetch invoice tax lines')
    })
  })

  describe('POST /api/routes-b/invoices/[id]/tax-lines', () => {
    it('creates a new tax line with provided name, rate, and amount', async () => {
      vi.mocked(prisma.invoiceTaxLine.create).mockResolvedValue({
        id: 'tl-new',
        invoiceId: mockInvoiceId,
        name: 'State Tax',
        rate: 5,
        amount: 50,
        taxRateId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never)

      const res = await POST(
        makePostRequest({ name: 'State Tax', rate: 5, amount: 50 }),
        { params },
      )
      expect(res.status).toBe(201)
      const data = await res.json()
      expect(data.taxLine.id).toBe('tl-new')
      expect(data.taxLine.name).toBe('State Tax')
      expect(data.taxLine.amount).toBe(50)
    })

    it('automatically calculates amount if not provided', async () => {
      vi.mocked(prisma.invoiceTaxLine.create).mockImplementation(async ({ data }: { data: unknown }) => ({
        id: 'tl-calc',
        ...(data as object),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never))

      const res = await POST(
        makePostRequest({ name: 'VAT', rate: 10 }), // 10% on 1000 = 100
        { params },
      )
      expect(res.status).toBe(201)
      const data = await res.json()
      expect(data.taxLine.amount).toBe(100)
    })

    it('creates tax line using existing taxRateId', async () => {
      vi.mocked(prisma.taxRate.findFirst).mockResolvedValue({
        id: 'tr-preset',
        userId: mockUserId,
        name: 'GST',
        rate: 15,
        isDefault: false,
      } as never)

      vi.mocked(prisma.invoiceTaxLine.create).mockResolvedValue({
        id: 'tl-from-rate',
        invoiceId: mockInvoiceId,
        name: 'GST',
        rate: 15,
        amount: 150,
        taxRateId: 'tr-preset',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never)

      const res = await POST(
        makePostRequest({ taxRateId: 'tr-preset' }),
        { params },
      )
      expect(res.status).toBe(201)
      const data = await res.json()
      expect(data.taxLine.taxRateId).toBe('tr-preset')
      expect(data.taxLine.name).toBe('GST')
    })

    it('returns 404 when taxRateId is not found', async () => {
      vi.mocked(prisma.taxRate.findFirst).mockResolvedValue(null)
      const res = await POST(
        makePostRequest({ taxRateId: 'invalid-tr' }),
        { params },
      )
      expect(res.status).toBe(404)
      const data = await res.json()
      expect(data.error).toBe('Tax rate not found')
    })

    it('returns 400 when name is missing', async () => {
      const res = await POST(makePostRequest({ rate: 10 }), { params })
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toContain('name is required')
    })

    it('returns 400 when rate is missing or invalid', async () => {
      const res1 = await POST(makePostRequest({ name: 'VAT' }), { params })
      expect(res1.status).toBe(400)

      const res2 = await POST(makePostRequest({ name: 'VAT', rate: -5 }), { params })
      expect(res2.status).toBe(400)

      const res3 = await POST(makePostRequest({ name: 'VAT', rate: 150 }), { params })
      expect(res3.status).toBe(400)
    })

    it('returns 400 when explicit amount is negative', async () => {
      const res = await POST(
        makePostRequest({ name: 'VAT', rate: 10, amount: -10 }),
        { params },
      )
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toContain('amount must be a non-negative number')
    })

    it('returns 401 when unauthorized', async () => {
      vi.mocked(verifyAuthToken).mockResolvedValue(null)
      const res = await POST(
        makePostRequest({ name: 'VAT', rate: 10 }),
        { params },
      )
      expect(res.status).toBe(401)
    })

    it('returns 404 when invoice is not found', async () => {
      vi.mocked(prisma.invoice.findFirst).mockResolvedValue(null)
      const res = await POST(
        makePostRequest({ name: 'VAT', rate: 10 }),
        { params },
      )
      expect(res.status).toBe(404)
    })

    it('returns 500 when database error occurs on create', async () => {
      vi.mocked(prisma.invoiceTaxLine.create).mockRejectedValue(new Error('DB failure'))
      const res = await POST(
        makePostRequest({ name: 'VAT', rate: 10 }),
        { params },
      )
      expect(res.status).toBe(500)
      const data = await res.json()
      expect(data.error).toBe('Failed to add invoice tax line')
    })
  })
})
