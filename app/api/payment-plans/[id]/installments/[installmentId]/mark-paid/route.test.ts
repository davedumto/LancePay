import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockVerifyAuthToken = vi.fn()
const mockUserFindUnique = vi.fn()
const mockPlanFindUnique = vi.fn()
const mockPlanUpdate = vi.fn()
const mockInstallmentFindUnique = vi.fn()
const mockInstallmentFindMany = vi.fn()
const mockInstallmentUpdateMany = vi.fn()
const mockInstallmentUpdate = vi.fn()
const mockInvoiceUpdate = vi.fn()

const txClient = {
  paymentPlan: {
    findUnique: (...args: unknown[]) => mockPlanFindUnique(...args),
    update: (...args: unknown[]) => mockPlanUpdate(...args),
  },
  paymentPlanInstallment: {
    findUnique: (...args: unknown[]) => mockInstallmentFindUnique(...args),
    findMany: (...args: unknown[]) => mockInstallmentFindMany(...args),
    updateMany: (...args: unknown[]) => mockInstallmentUpdateMany(...args),
    update: (...args: unknown[]) => mockInstallmentUpdate(...args),
  },
  invoice: {
    update: (...args: unknown[]) => mockInvoiceUpdate(...args),
  },
}

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: (...args: unknown[]) => mockVerifyAuthToken(...args),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
    },
    paymentPlan: {
      findUnique: (...args: unknown[]) => mockPlanFindUnique(...args),
      update: (...args: unknown[]) => mockPlanUpdate(...args),
    },
    paymentPlanInstallment: {
      findUnique: (...args: unknown[]) => mockInstallmentFindUnique(...args),
      findMany: (...args: unknown[]) => mockInstallmentFindMany(...args),
      updateMany: (...args: unknown[]) => mockInstallmentUpdateMany(...args),
      update: (...args: unknown[]) => mockInstallmentUpdate(...args),
    },
    invoice: {
      update: (...args: unknown[]) => mockInvoiceUpdate(...args),
    },
    $transaction: vi.fn(async (cb: (tx: typeof txClient) => unknown) =>
      cb(txClient),
    ),
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}))

import { PATCH } from './route'

function makeRequest(url: string, options?: { token?: string }) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (options?.token) {
    headers.authorization = `Bearer ${options.token}`
  }
  return new NextRequest(url, {
    method: 'PATCH',
    headers,
  })
}

describe('PATCH /api/payment-plans/[id]/installments/[installmentId]/mark-paid', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'user-1' })
    mockUserFindUnique.mockResolvedValue({
      id: 'user-1',
      privyId: 'user-1',
      role: 'user',
    })
    mockInstallmentUpdateMany.mockResolvedValue({ count: 1 })
  })

  it('rejects marking an installment paid if it is already paid with 409', async () => {
    const paidDate = new Date('2026-04-01T10:00:00Z')
    mockPlanFindUnique.mockResolvedValue({
      id: 'plan-1',
      userId: 'user-1',
      invoiceId: 'inv-1',
      status: 'active',
      installments: [
        {
          id: 'inst-1',
          paymentPlanId: 'plan-1',
          sequence: 1,
          amount: 50,
          dueDate: paidDate,
          status: 'paid',
          paidAt: paidDate,
        },
        {
          id: 'inst-2',
          paymentPlanId: 'plan-1',
          sequence: 2,
          amount: 50,
          dueDate: paidDate,
          status: 'pending',
          paidAt: null,
        },
      ],
    })

    const req = makeRequest(
      'http://localhost/api/payment-plans/plan-1/installments/inst-1/mark-paid',
      { token: 'valid-token' },
    )

    const res = await PATCH(req, {
      params: { id: 'plan-1', installmentId: 'inst-1' },
    })
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.code).toBe('INSTALLMENT_ALREADY_PAID')
    expect(mockInstallmentUpdate).not.toHaveBeenCalled()
    expect(mockPlanUpdate).not.toHaveBeenCalled()
    expect(mockInvoiceUpdate).not.toHaveBeenCalled()
  })

  it('marks an intermediate installment paid without completing the PaymentPlan or marking the parent Invoice paid', async () => {
    const due1 = new Date('2026-05-01T00:00:00Z')
    const due2 = new Date('2026-06-01T00:00:00Z')

    mockPlanFindUnique.mockResolvedValue({
      id: 'plan-1',
      userId: 'user-1',
      invoiceId: 'inv-1',
      status: 'active',
      installments: [
        {
          id: 'inst-1',
          paymentPlanId: 'plan-1',
          sequence: 1,
          amount: 50,
          dueDate: due1,
          status: 'pending',
          paidAt: null,
        },
        {
          id: 'inst-2',
          paymentPlanId: 'plan-1',
          sequence: 2,
          amount: 50,
          dueDate: due2,
          status: 'pending',
          paidAt: null,
        },
      ],
    })

    mockInstallmentUpdate.mockImplementation(async ({ data }: any) => ({
      id: 'inst-1',
      paymentPlanId: 'plan-1',
      sequence: 1,
      amount: 50,
      dueDate: due1,
      status: data.status,
      paidAt: data.paidAt,
    }))

    mockInstallmentFindMany.mockResolvedValue([
      {
        id: 'inst-1',
        paymentPlanId: 'plan-1',
        sequence: 1,
        amount: 50,
        dueDate: due1,
        status: 'paid',
        paidAt: new Date(),
      },
      {
        id: 'inst-2',
        paymentPlanId: 'plan-1',
        sequence: 2,
        amount: 50,
        dueDate: due2,
        status: 'pending',
        paidAt: null,
      },
    ])

    const req = makeRequest(
      'http://localhost/api/payment-plans/plan-1/installments/inst-1/mark-paid',
      { token: 'valid-token' },
    )

    const res = await PATCH(req, {
      params: { id: 'plan-1', installmentId: 'inst-1' },
    })
    expect(res.status).toBe(200)

    const json = await res.json()
    expect(json.installment.status).toBe('paid')
    expect(json.installment.paidAt).toBeTruthy()
    expect(json.paymentPlan.status).toBe('active')
    expect(json.paymentPlan.completed).toBe(false)
    expect(json.paymentPlan.paidInstallments).toBe(1)
    expect(json.paymentPlan.totalInstallments).toBe(2)
    expect(json.invoice.markedPaid).toBe(false)

    expect(mockPlanUpdate).not.toHaveBeenCalled()
    expect(mockInvoiceUpdate).not.toHaveBeenCalled()
  })

  it('completes the PaymentPlan and marks the parent Invoice paid when the final installment is marked paid', async () => {
    const due1 = new Date('2026-05-01T00:00:00Z')
    const due2 = new Date('2026-06-01T00:00:00Z')
    const paid1At = new Date('2026-04-15T10:00:00Z')

    mockPlanFindUnique.mockResolvedValue({
      id: 'plan-1',
      userId: 'user-1',
      invoiceId: 'inv-1',
      status: 'active',
      installments: [
        {
          id: 'inst-1',
          paymentPlanId: 'plan-1',
          sequence: 1,
          amount: 50,
          dueDate: due1,
          status: 'paid',
          paidAt: paid1At,
        },
        {
          id: 'inst-2',
          paymentPlanId: 'plan-1',
          sequence: 2,
          amount: 50,
          dueDate: due2,
          status: 'pending',
          paidAt: null,
        },
      ],
    })

    mockInstallmentUpdate.mockImplementation(async ({ data }: any) => ({
      id: 'inst-2',
      paymentPlanId: 'plan-1',
      sequence: 2,
      amount: 50,
      dueDate: due2,
      status: data.status,
      paidAt: data.paidAt,
    }))

    mockInstallmentFindMany.mockResolvedValue([
      {
        id: 'inst-1',
        paymentPlanId: 'plan-1',
        sequence: 1,
        amount: 50,
        dueDate: due1,
        status: 'paid',
        paidAt: paid1At,
      },
      {
        id: 'inst-2',
        paymentPlanId: 'plan-1',
        sequence: 2,
        amount: 50,
        dueDate: due2,
        status: 'paid',
        paidAt: new Date(),
      },
    ])

    mockPlanUpdate.mockResolvedValue({
      id: 'plan-1',
      status: 'completed',
    })

    mockInvoiceUpdate.mockResolvedValue({
      id: 'inv-1',
      status: 'paid',
      paidAt: new Date(),
    })

    const req = makeRequest(
      'http://localhost/api/payment-plans/plan-1/installments/inst-2/mark-paid',
      { token: 'valid-token' },
    )

    const res = await PATCH(req, {
      params: { id: 'plan-1', installmentId: 'inst-2' },
    })
    expect(res.status).toBe(200)

    const json = await res.json()
    expect(json.installment.status).toBe('paid')
    expect(json.installment.paidAt).toBeTruthy()
    expect(json.paymentPlan.status).toBe('completed')
    expect(json.paymentPlan.completed).toBe(true)
    expect(json.paymentPlan.paidInstallments).toBe(2)
    expect(json.invoice.markedPaid).toBe(true)
    expect(json.invoice.status).toBe('paid')

    expect(mockPlanUpdate).toHaveBeenCalledWith({
      where: { id: 'plan-1' },
      data: { status: 'completed' },
    })
    expect(mockInvoiceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'inv-1' },
        data: expect.objectContaining({
          status: 'paid',
          paidAt: expect.any(Date),
        }),
      }),
    )
  })
})
