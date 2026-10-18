import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockVerifyAuthToken = vi.fn()
const mockUserFindUnique = vi.fn()
const mockInvoiceFindUnique = vi.fn()
const mockPlanFindUnique = vi.fn()
const mockPlanCreate = vi.fn()

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: (...args: unknown[]) => mockVerifyAuthToken(...args),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
    },
    invoice: {
      findUnique: (...args: unknown[]) => mockInvoiceFindUnique(...args),
    },
    paymentPlan: {
      findUnique: (...args: unknown[]) => mockPlanFindUnique(...args),
      create: (...args: unknown[]) => mockPlanCreate(...args),
    },
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}))

import {
  GET,
  POST,
  computeInstallmentAmounts,
  computeInstallmentDates,
} from './route'

function makeRequest(
  url: string,
  options?: { method?: string; token?: string; body?: unknown },
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (options?.token) {
    headers.authorization = `Bearer ${options.token}`
  }
  return new NextRequest(url, {
    method: options?.method ?? 'POST',
    headers,
    body:
      options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  })
}

describe('Invoice Payment Plans API (/api/invoices/[id]/payment-plans)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'user-1' })
    mockUserFindUnique.mockResolvedValue({
      id: 'user-1',
      privyId: 'user-1',
      role: 'user',
    })
    mockPlanFindUnique.mockResolvedValue(null)
  })

  it('enforces the unique invoiceId constraint (only one plan per invoice, 409)', async () => {
    mockInvoiceFindUnique.mockResolvedValue({
      id: 'inv-1',
      userId: 'user-1',
      amount: 100,
      currency: 'USD',
      createdAt: new Date('2026-04-01T00:00:00Z'),
    })
    mockPlanFindUnique.mockResolvedValue({
      id: 'plan-existing',
      invoiceId: 'inv-1',
      status: 'active',
    })

    const req = makeRequest('http://localhost/api/invoices/inv-1/payment-plans', {
      token: 'valid-token',
      body: { installmentCount: 3, frequency: 'monthly' },
    })

    const res = await POST(req, { params: { id: 'inv-1' } })
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.code).toBe('PAYMENT_PLAN_ALREADY_EXISTS')
    expect(mockPlanCreate).not.toHaveBeenCalled()
  })

  it('computes installment amounts that sum to totalAmount, allocating any rounding remainder to the final installment', async () => {
    expect(computeInstallmentAmounts(100, 3)).toEqual([33.33, 33.33, 33.34])
    expect(
      computeInstallmentAmounts(100, 3).reduce((sum, a) => sum + a, 0),
    ).toBeCloseTo(100, 2)

    const invoiceCreatedAt = new Date('2026-04-01T00:00:00.000Z')
    mockInvoiceFindUnique.mockResolvedValue({
      id: 'inv-1',
      userId: 'user-1',
      amount: 100,
      currency: 'USD',
      createdAt: invoiceCreatedAt,
    })

    mockPlanCreate.mockImplementation(async ({ data }: any) => ({
      id: 'plan-1',
      userId: data.userId,
      invoiceId: data.invoiceId,
      totalAmount: data.totalAmount,
      currency: data.currency,
      installmentCount: data.installmentCount,
      frequency: data.frequency,
      status: data.status,
      createdAt: invoiceCreatedAt,
      updatedAt: invoiceCreatedAt,
      installments: data.installments.create.map((inst: any, i: number) => ({
        id: `inst-${i + 1}`,
        paymentPlanId: 'plan-1',
        ...inst,
        paidAt: null,
      })),
    }))

    const req = makeRequest('http://localhost/api/invoices/inv-1/payment-plans', {
      token: 'valid-token',
      body: { installmentCount: 3, frequency: 'monthly' },
    })

    const res = await POST(req, { params: { id: 'inv-1' } })
    expect(res.status).toBe(201)

    const json = await res.json()
    expect(json.paymentPlan.totalAmount).toBe(100)
    expect(json.paymentPlan.installments.map((i: any) => i.amount)).toEqual([
      33.33, 33.33, 33.34,
    ])
    const sum = json.paymentPlan.installments.reduce(
      (acc: number, i: any) => acc + i.amount,
      0,
    )
    expect(Math.round(sum * 100)).toBe(10000)
  })

  it('sets each installment dueDate based on frequency (weekly, biweekly, monthly) starting from the invoice date', () => {
    const start = new Date('2026-04-01T00:00:00.000Z')

    const weekly = computeInstallmentDates(2, 'weekly', start)
    expect(weekly.map((d) => d.toISOString())).toEqual([
      '2026-04-08T00:00:00.000Z',
      '2026-04-15T00:00:00.000Z',
    ])

    const biweekly = computeInstallmentDates(2, 'biweekly', start)
    expect(biweekly.map((d) => d.toISOString())).toEqual([
      '2026-04-15T00:00:00.000Z',
      '2026-04-29T00:00:00.000Z',
    ])

    const monthly = computeInstallmentDates(2, 'monthly', start)
    expect(monthly.map((d) => d.toISOString())).toEqual([
      '2026-05-01T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
    ])
  })

  it('fetches the existing payment plan for an invoice via GET', async () => {
    mockInvoiceFindUnique.mockResolvedValue({
      id: 'inv-1',
      userId: 'user-1',
      amount: 100,
      currency: 'USD',
    })
    mockPlanFindUnique.mockResolvedValue({
      id: 'plan-1',
      userId: 'user-1',
      invoiceId: 'inv-1',
      totalAmount: 100,
      currency: 'USD',
      installmentCount: 2,
      frequency: 'biweekly',
      status: 'active',
      createdAt: new Date('2026-04-01T00:00:00.000Z'),
      updatedAt: new Date('2026-04-01T00:00:00.000Z'),
      installments: [
        {
          id: 'inst-1',
          sequence: 1,
          amount: 50,
          dueDate: new Date('2026-04-15T00:00:00.000Z'),
          status: 'pending',
          paidAt: null,
        },
        {
          id: 'inst-2',
          sequence: 2,
          amount: 50,
          dueDate: new Date('2026-04-29T00:00:00.000Z'),
          status: 'pending',
          paidAt: null,
        },
      ],
    })

    const req = makeRequest('http://localhost/api/invoices/inv-1/payment-plans', {
      method: 'GET',
      token: 'valid-token',
    })

    const res = await GET(req, { params: { id: 'inv-1' } })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.paymentPlan.id).toBe('plan-1')
    expect(json.paymentPlan.installments).toHaveLength(2)
  })
})
