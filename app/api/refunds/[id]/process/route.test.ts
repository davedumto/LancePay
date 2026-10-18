import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockVerifyAuthToken = vi.fn()
const mockUserFindUnique = vi.fn()
const mockRefundFindUnique = vi.fn()
const mockRefundFindMany = vi.fn()
const mockRefundUpdateMany = vi.fn()
const mockRefundUpdate = vi.fn()
const mockInvoiceFindUnique = vi.fn()
const mockInvoiceUpdate = vi.fn()

const txClient = {
  refund: {
    findUnique: (...args: unknown[]) => mockRefundFindUnique(...args),
    findMany: (...args: unknown[]) => mockRefundFindMany(...args),
    updateMany: (...args: unknown[]) => mockRefundUpdateMany(...args),
    update: (...args: unknown[]) => mockRefundUpdate(...args),
  },
  invoice: {
    findUnique: (...args: unknown[]) => mockInvoiceFindUnique(...args),
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
    refund: {
      findUnique: (...args: unknown[]) => mockRefundFindUnique(...args),
      findMany: (...args: unknown[]) => mockRefundFindMany(...args),
      updateMany: (...args: unknown[]) => mockRefundUpdateMany(...args),
      update: (...args: unknown[]) => mockRefundUpdate(...args),
    },
    invoice: {
      findUnique: (...args: unknown[]) => mockInvoiceFindUnique(...args),
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

function makeRequest(
  url: string,
  options?: { token?: string; body?: unknown },
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (options?.token) {
    headers.authorization = `Bearer ${options.token}`
  }
  return new NextRequest(url, {
    method: 'PATCH',
    headers,
    body:
      options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  })
}

describe('PATCH /api/refunds/[id]/process', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'admin-1' })
    mockUserFindUnique.mockResolvedValue({
      id: 'admin-1',
      privyId: 'admin-1',
      role: 'admin',
    })
    mockRefundUpdateMany.mockResolvedValue({ count: 1 })
  })

  it('rejects non-admin callers with 403', async () => {
    mockUserFindUnique.mockResolvedValue({
      id: 'user-1',
      privyId: 'user-1',
      role: 'user',
    })

    const req = makeRequest('http://localhost/api/refunds/ref-1/process', {
      token: 'user-token',
      body: { status: 'completed' },
    })

    const res = await PATCH(req, { params: { id: 'ref-1' } })
    expect(res.status).toBe(403)
    const json = await res.json()
    expect(json.code).toBe('ADMIN_REQUIRED')
    expect(mockRefundUpdate).not.toHaveBeenCalled()
  })

  it('rejects attempts to re-process an already-terminal (completed or failed) refund with 409', async () => {
    mockRefundFindUnique.mockResolvedValue({
      id: 'ref-1',
      userId: 'user-1',
      invoiceId: 'inv-1',
      amount: 50,
      currency: 'USD',
      reason: 'Duplicate charge',
      status: 'completed',
      createdAt: new Date('2026-04-01T10:00:00Z'),
      updatedAt: new Date('2026-04-01T10:05:00Z'),
    })

    const req = makeRequest('http://localhost/api/refunds/ref-1/process', {
      token: 'admin-token',
      body: { status: 'failed' },
    })

    const res = await PATCH(req, { params: { id: 'ref-1' } })
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.code).toBe('REFUND_ALREADY_PROCESSED')
    expect(json.currentStatus).toBe('completed')
    expect(mockRefundUpdate).not.toHaveBeenCalled()
  })

  it('transitions a pending refund to completed and updates invoice paid-amount accounting', async () => {
    const now = new Date('2026-04-02T12:00:00Z')
    mockRefundFindUnique.mockResolvedValue({
      id: 'ref-1',
      userId: 'user-1',
      invoiceId: 'inv-1',
      amount: 40,
      currency: 'USD',
      reason: 'Partial credit',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    })

    mockRefundUpdate.mockResolvedValue({
      id: 'ref-1',
      userId: 'user-1',
      invoiceId: 'inv-1',
      amount: 40,
      currency: 'USD',
      reason: 'Partial credit',
      status: 'completed',
      createdAt: now,
      updatedAt: now,
    })

    mockInvoiceFindUnique.mockResolvedValue({
      id: 'inv-1',
      userId: 'user-1',
      amount: 100,
      currency: 'USD',
      status: 'paid',
      paidAt: now,
    })

    mockRefundFindMany.mockResolvedValue([
      {
        id: 'ref-1',
        invoiceId: 'inv-1',
        amount: 40,
        status: 'completed',
      },
      {
        id: 'ref-2',
        invoiceId: 'inv-1',
        amount: 15,
        status: 'pending',
      },
    ])

    const req = makeRequest('http://localhost/api/refunds/ref-1/process', {
      token: 'admin-token',
      body: { status: 'completed' },
    })

    const res = await PATCH(req, { params: { id: 'ref-1' } })
    expect(res.status).toBe(200)

    const json = await res.json()
    expect(json.refund.status).toBe('completed')
    expect(json.invoiceAccounting).toEqual({
      invoiceId: 'inv-1',
      invoiceAmount: 100,
      grossPaidAmount: 100,
      completedRefundsTotal: 40,
      pendingRefundsTotal: 15,
      netPaidAmount: 60,
      remainingRefundableAmount: 45,
      invoiceStatus: 'paid',
    })
    expect(mockInvoiceUpdate).not.toHaveBeenCalled()
  })

  it('marks the parent invoice as refunded when completed refunds equal the paid invoice amount', async () => {
    const now = new Date('2026-04-02T12:00:00Z')
    mockRefundFindUnique.mockResolvedValue({
      id: 'ref-full',
      userId: 'user-1',
      invoiceId: 'inv-1',
      amount: 100,
      currency: 'USD',
      reason: 'Full cancellation',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    })

    mockRefundUpdate.mockResolvedValue({
      id: 'ref-full',
      userId: 'user-1',
      invoiceId: 'inv-1',
      amount: 100,
      currency: 'USD',
      reason: 'Full cancellation',
      status: 'completed',
      createdAt: now,
      updatedAt: now,
    })

    mockInvoiceFindUnique.mockResolvedValue({
      id: 'inv-1',
      userId: 'user-1',
      amount: 100,
      currency: 'USD',
      status: 'paid',
      paidAt: now,
    })

    mockRefundFindMany.mockResolvedValue([
      {
        id: 'ref-full',
        invoiceId: 'inv-1',
        amount: 100,
        status: 'completed',
      },
    ])

    const req = makeRequest('http://localhost/api/refunds/ref-full/process', {
      token: 'admin-token',
      body: { status: 'completed' },
    })

    const res = await PATCH(req, { params: { id: 'ref-full' } })
    expect(res.status).toBe(200)

    const json = await res.json()
    expect(json.invoiceAccounting.netPaidAmount).toBe(0)
    expect(json.invoiceAccounting.remainingRefundableAmount).toBe(0)
    expect(json.invoiceAccounting.invoiceStatus).toBe('refunded')
    expect(mockInvoiceUpdate).toHaveBeenCalledWith({
      where: { id: 'inv-1' },
      data: { status: 'refunded' },
    })
  })

  it('transitions a pending refund to failed without altering invoice accounting', async () => {
    const now = new Date('2026-04-02T12:00:00Z')
    mockRefundFindUnique.mockResolvedValue({
      id: 'ref-fail',
      userId: 'user-1',
      invoiceId: 'inv-1',
      amount: 25,
      currency: 'USD',
      reason: 'Processor declined',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    })

    mockRefundUpdate.mockResolvedValue({
      id: 'ref-fail',
      userId: 'user-1',
      invoiceId: 'inv-1',
      amount: 25,
      currency: 'USD',
      reason: 'Processor declined',
      status: 'failed',
      createdAt: now,
      updatedAt: now,
    })

    const req = makeRequest('http://localhost/api/refunds/ref-fail/process', {
      token: 'admin-token',
      body: { status: 'failed' },
    })

    const res = await PATCH(req, { params: { id: 'ref-fail' } })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.refund.status).toBe('failed')
    expect(json.invoiceAccounting).toBeUndefined()
  })
})
