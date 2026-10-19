import { describe, it, expect, beforeEach, vi } from 'vitest'
import { GET, POST } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { findFirst: vi.fn() },
    paymentPlan: { findFirst: vi.fn(), create: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const mockUserId = 'user-123'
const mockPrivyId = 'privy-123'
const mockInvoiceId = 'invoice-123'
const params = { id: mockInvoiceId }

function makeRequest(method: 'GET' | 'POST', body?: any) {
  return new NextRequest(`http://localhost:3000/api/invoices/${mockInvoiceId}/payment-plans`, {
    method,
    headers: { Authorization: 'Bearer valid-token' },
    body: body ? JSON.stringify(body) : undefined,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: mockPrivyId } as never)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: mockUserId } as never)
})

describe('GET /api/invoices/[id]/payment-plans', () => {
  it('returns the payment plan for the authenticated owner', async () => {
    const mockInvoice = {
      id: mockInvoiceId,
      amount: 1000,
      currency: 'USD',
      createdAt: new Date(),
    }
    vi.mocked(prisma.invoice.findFirst).mockResolvedValue(mockInvoice as never)

    const mockPaymentPlan = {
      id: 'plan-1',
      invoiceId: mockInvoiceId,
      totalAmount: 1000,
      currency: 'USD',
      installmentCount: 3,
      frequency: 'monthly',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
      installments: [
        {
          id: 'installment-1',
          sequence: 1,
          amount: 333.33,
          dueDate: new Date(),
          status: 'pending',
          paidAt: null,
          createdAt: new Date(),
        },
        {
          id: 'installment-2',
          sequence: 2,
          amount: 333.33,
          dueDate: new Date(),
          status: 'pending',
          paidAt: null,
          createdAt: new Date(),
        },
        {
          id: 'installment-3',
          sequence: 3,
          amount: 333.34,
          dueDate: new Date(),
          status: 'pending',
          paidAt: null,
          createdAt: new Date(),
        },
      ],
    }
    vi.mocked(prisma.paymentPlan.findFirst).mockResolvedValue(mockPaymentPlan as never)

    const res = await GET(makeRequest('GET'), { params })
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.paymentPlan.id).toBe('plan-1')
    expect(data.paymentPlan.installments).toHaveLength(3)
  })

  it('returns 401 when no auth token provided', async () => {
    const request = new NextRequest(`http://localhost:3000/api/invoices/${mockInvoiceId}/payment-plans`)
    const res = await GET(request, { params })
    expect(res.status).toBe(401)
  })

  it('returns 404 when invoice does not exist', async () => {
    vi.mocked(prisma.invoice.findFirst).mockResolvedValue(null)
    const res = await GET(makeRequest('GET'), { params })
    expect(res.status).toBe(404)
  })

  it('returns 404 when payment plan does not exist', async () => {
    const mockInvoice = {
      id: mockInvoiceId,
      amount: 1000,
      currency: 'USD',
      createdAt: new Date(),
    }
    vi.mocked(prisma.invoice.findFirst).mockResolvedValue(mockInvoice as never)
    vi.mocked(prisma.paymentPlan.findFirst).mockResolvedValue(null)

    const res = await GET(makeRequest('GET'), { params })
    expect(res.status).toBe(404)
  })

  it('returns 500 on database error', async () => {
    vi.mocked(prisma.invoice.findFirst).mockRejectedValue(new Error('Database error'))
    const res = await GET(makeRequest('GET'), { params })
    expect(res.status).toBe(500)
  })
})

describe('POST /api/invoices/[id]/payment-plans', () => {
  it('creates a payment plan with correct installment amounts', async () => {
    const mockInvoice = {
      id: mockInvoiceId,
      amount: 1000,
      currency: 'USD',
      createdAt: new Date('2024-01-01'),
    }
    vi.mocked(prisma.invoice.findFirst).mockResolvedValue(mockInvoice as never)
    vi.mocked(prisma.paymentPlan.findFirst).mockResolvedValue(null)

    const mockPaymentPlan = {
      id: 'plan-1',
      invoiceId: mockInvoiceId,
      totalAmount: 1000,
      currency: 'USD',
      installmentCount: 3,
      frequency: 'monthly',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
      installments: [
        {
          id: 'installment-1',
          sequence: 1,
          amount: 333.33,
          dueDate: new Date('2024-01-01'),
          status: 'pending',
          paidAt: null,
          createdAt: new Date(),
        },
        {
          id: 'installment-2',
          sequence: 2,
          amount: 333.33,
          dueDate: new Date('2024-02-01'),
          status: 'pending',
          paidAt: null,
          createdAt: new Date(),
        },
        {
          id: 'installment-3',
          sequence: 3,
          amount: 333.34,
          dueDate: new Date('2024-03-01'),
          status: 'pending',
          paidAt: null,
          createdAt: new Date(),
        },
      ],
    }
    vi.mocked(prisma.paymentPlan.create).mockResolvedValue(mockPaymentPlan as never)

    const res = await POST(
      makeRequest('POST', { installmentCount: 3, frequency: 'monthly' }),
      { params },
    )
    const data = await res.json()

    expect(res.status).toBe(201)
    expect(data.paymentPlan.installmentCount).toBe(3)
    expect(data.paymentPlan.installments).toHaveLength(3)

    const amounts = data.paymentPlan.installments.map((i: any) => i.amount)
    const total = amounts.reduce((sum: number, a: number) => sum + a, 0)
    expect(total).toBe(1000)
  })

  it('rejects when a payment plan already exists', async () => {
    const mockInvoice = {
      id: mockInvoiceId,
      amount: 1000,
      currency: 'USD',
      createdAt: new Date(),
    }
    vi.mocked(prisma.invoice.findFirst).mockResolvedValue(mockInvoice as never)
    vi.mocked(prisma.paymentPlan.findFirst).mockResolvedValue({ id: 'existing-plan' } as never)

    const res = await POST(
      makeRequest('POST', { installmentCount: 3, frequency: 'monthly' }),
      { params },
    )
    expect(res.status).toBe(409)
  })

  it('rejects invalid installment count', async () => {
    const mockInvoice = {
      id: mockInvoiceId,
      amount: 1000,
      currency: 'USD',
      createdAt: new Date(),
    }
    vi.mocked(prisma.invoice.findFirst).mockResolvedValue(mockInvoice as never)
    vi.mocked(prisma.paymentPlan.findFirst).mockResolvedValue(null)

    const res = await POST(
      makeRequest('POST', { installmentCount: 1, frequency: 'monthly' }),
      { params },
    )
    expect(res.status).toBe(400)
  })

  it('rejects invalid frequency', async () => {
    const mockInvoice = {
      id: mockInvoiceId,
      amount: 1000,
      currency: 'USD',
      createdAt: new Date(),
    }
    vi.mocked(prisma.invoice.findFirst).mockResolvedValue(mockInvoice as never)
    vi.mocked(prisma.paymentPlan.findFirst).mockResolvedValue(null)

    const res = await POST(
      makeRequest('POST', { installmentCount: 3, frequency: 'invalid' }),
      { params },
    )
    expect(res.status).toBe(400)
  })

  it('uses custom start date when provided', async () => {
    const mockInvoice = {
      id: mockInvoiceId,
      amount: 1000,
      currency: 'USD',
      createdAt: new Date('2024-01-01'),
    }
    vi.mocked(prisma.invoice.findFirst).mockResolvedValue(mockInvoice as never)
    vi.mocked(prisma.paymentPlan.findFirst).mockResolvedValue(null)

    const mockPaymentPlan = {
      id: 'plan-1',
      invoiceId: mockInvoiceId,
      totalAmount: 1000,
      currency: 'USD',
      installmentCount: 2,
      frequency: 'monthly',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
      installments: [],
    }
    vi.mocked(prisma.paymentPlan.create).mockResolvedValue(mockPaymentPlan as never)

    const res = await POST(
      makeRequest('POST', {
        installmentCount: 2,
        frequency: 'monthly',
        startDate: '2024-02-01',
      }),
      { params },
    )
    expect(res.status).toBe(201)
  })

  it('rejects invalid start date', async () => {
    const mockInvoice = {
      id: mockInvoiceId,
      amount: 1000,
      currency: 'USD',
      createdAt: new Date(),
    }
    vi.mocked(prisma.invoice.findFirst).mockResolvedValue(mockInvoice as never)
    vi.mocked(prisma.paymentPlan.findFirst).mockResolvedValue(null)

    const res = await POST(
      makeRequest('POST', {
        installmentCount: 3,
        frequency: 'monthly',
        startDate: 'invalid-date',
      }),
      { params },
    )
    expect(res.status).toBe(400)
  })

  it('returns 401 when no auth token provided', async () => {
    const request = new NextRequest(`http://localhost:3000/api/invoices/${mockInvoiceId}/payment-plans`, {
      method: 'POST',
      body: JSON.stringify({ installmentCount: 3, frequency: 'monthly' }),
    })
    const res = await POST(request, { params })
    expect(res.status).toBe(401)
  })

  it('returns 404 when invoice does not exist', async () => {
    vi.mocked(prisma.invoice.findFirst).mockResolvedValue(null)
    const res = await POST(
      makeRequest('POST', { installmentCount: 3, frequency: 'monthly' }),
      { params },
    )
    expect(res.status).toBe(404)
  })

  it('returns 500 on database error', async () => {
    vi.mocked(prisma.invoice.findFirst).mockRejectedValue(new Error('Database error'))
    const res = await POST(
      makeRequest('POST', { installmentCount: 3, frequency: 'monthly' }),
      { params },
    )
    expect(res.status).toBe(500)
  })
})
