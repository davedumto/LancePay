import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const { mockPrisma, mockVerifyAuthToken } = vi.hoisted(() => ({
  mockPrisma: {
    invoice: {
      findUnique: vi.fn(),
    },
    manualPayment: {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
  },
  mockVerifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: mockVerifyAuthToken }))

import { GET, POST } from './route'

function makePostRequest(body: unknown, token: string | null = 'valid-token'): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest('http://localhost/api/manual-payments', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

function makeGetRequest(params = '', token: string | null = 'valid-token'): NextRequest {
  const url = `http://localhost/api/manual-payments${params ? `?${params}` : ''}`
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest(url, { method: 'GET', headers })
}

describe('POST /api/manual-payments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({
      userId: 'user-1',
      email: 'freelancer@lancepay.io',
      role: 'user',
    })
    mockPrisma.manualPayment.findMany.mockResolvedValue([])
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await POST(
      makePostRequest({ invoiceId: 'inv-1', amountPaid: 100, paymentMethod: 'bank_transfer' }, null),
    )
    expect(res.status).toBe(401)
  })

  it('returns 400 when paymentMethod or receiptUrl is invalid', async () => {
    const resInvalidMethod = await POST(
      makePostRequest({ invoiceId: 'inv-1', amountPaid: 100, paymentMethod: 'crypto_swap' }),
    )
    expect(resInvalidMethod.status).toBe(400)

    const resInvalidUrl = await POST(
      makePostRequest({
        invoiceId: 'inv-1',
        amountPaid: 100,
        paymentMethod: 'bank_transfer',
        receiptUrl: 'ftp://bad-url',
      }),
    )
    expect(resInvalidUrl.status).toBe(400)
  })

  it('returns 404 when invoice does not exist', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValueOnce(null)
    const res = await POST(
      makePostRequest({ invoiceId: 'inv-missing', amountPaid: 100, paymentMethod: 'bank_transfer' }),
    )
    expect(res.status).toBe(404)
  })

  it('returns 403 when user does not own the invoice', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValueOnce({
      id: 'inv-other',
      userId: 'user-2',
      amount: 500,
      currency: 'USDC',
      status: 'pending',
    })
    const res = await POST(
      makePostRequest({ invoiceId: 'inv-other', amountPaid: 100, paymentMethod: 'bank_transfer' }),
    )
    expect(res.status).toBe(403)
  })

  it('returns 409 when invoice is already paid', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValueOnce({
      id: 'inv-paid',
      userId: 'user-1',
      amount: 500,
      currency: 'USDC',
      status: 'paid',
    })
    const res = await POST(
      makePostRequest({ invoiceId: 'inv-paid', amountPaid: 100, paymentMethod: 'bank_transfer' }),
    )
    expect(res.status).toBe(409)
  })

  it('returns 422 when amountPaid exceeds remaining invoice balance', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValueOnce({
      id: 'inv-1',
      userId: 'user-1',
      amount: 500,
      currency: 'USDC',
      status: 'pending',
    })
    mockPrisma.manualPayment.findMany.mockResolvedValueOnce([
      { id: 'mp-1', amountPaid: 300, status: 'verified' },
    ])

    const res = await POST(
      makePostRequest({ invoiceId: 'inv-1', amountPaid: 250, paymentMethod: 'wire' }),
    )
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.remainingBalance).toBe(200)
  })

  it('creates a pending manual payment record and returns 201', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValueOnce({
      id: 'inv-1',
      userId: 'user-1',
      amount: 500,
      currency: 'USDC',
      status: 'pending',
    })
    mockPrisma.manualPayment.create.mockResolvedValueOnce({
      id: 'mp-new',
      invoiceId: 'inv-1',
      amountPaid: 250,
      currency: 'USDC',
      paymentMethod: 'bank_transfer',
      receiptUrl: 'https://cdn.lancepay.io/receipts/r1.pdf',
      notes: 'First installment via wire',
      status: 'pending',
      createdAt: new Date('2026-03-01T10:00:00Z'),
    })

    const res = await POST(
      makePostRequest({
        invoiceId: 'inv-1',
        amountPaid: 250,
        paymentMethod: 'bank_transfer',
        receiptUrl: 'https://cdn.lancepay.io/receipts/r1.pdf',
        notes: 'First installment via wire',
      }),
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.manualPayment.id).toBe('mp-new')
    expect(body.manualPayment.amountPaid).toBe(250)
    expect(body.manualPayment.status).toBe('pending')
  })
})

describe('GET /api/manual-payments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({
      userId: 'user-1',
      email: 'freelancer@lancepay.io',
      role: 'user',
    })
  })

  it('lists manual payments scoped to user invoices', async () => {
    mockPrisma.manualPayment.findMany.mockResolvedValueOnce([
      {
        id: 'mp-1',
        invoiceId: 'inv-1',
        amountPaid: 200,
        currency: 'USDC',
        paymentMethod: 'bank_transfer',
        status: 'pending',
      },
    ])
    mockPrisma.manualPayment.count.mockResolvedValueOnce(1)

    const res = await GET(makeGetRequest('status=pending'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].amountPaid).toBe(200)
  })
})
