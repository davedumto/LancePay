import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockVerifyAuthToken = vi.fn()
const mockUserFindUnique = vi.fn()
const mockInvoiceFindUnique = vi.fn()
const mockRefundFindMany = vi.fn()
const mockRefundCreate = vi.fn()
const mockLogAuditEvent = vi.fn()

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
    refund: {
      findMany: (...args: unknown[]) => mockRefundFindMany(...args),
      create: (...args: unknown[]) => mockRefundCreate(...args),
    },
  },
}))

vi.mock('@/lib/audit', () => ({
  extractRequestMetadata: () => ({ ip: '127.0.0.1' }),
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}))

import { GET, POST } from './route'

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

describe('Invoice Refunds API (/api/invoices/[id]/refunds)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'user-1' })
    mockUserFindUnique.mockResolvedValue({
      id: 'user-1',
      privyId: 'user-1',
      role: 'user',
    })
    mockRefundFindMany.mockResolvedValue([])
  })

  it('requires a non-empty reason', async () => {
    const req = makeRequest('http://localhost/api/invoices/inv-1/refunds', {
      token: 'valid-token',
      body: { amount: 25, reason: '   ' },
    })

    const res = await POST(req, { params: { id: 'inv-1' } })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.code).toBe('REASON_REQUIRED')
    expect(mockRefundCreate).not.toHaveBeenCalled()
  })

  it('rejects refunding an unpaid invoice with 422', async () => {
    mockInvoiceFindUnique.mockResolvedValue({
      id: 'inv-unpaid',
      userId: 'user-1',
      amount: 100,
      currency: 'USD',
      status: 'pending',
      paidAt: null,
    })

    const req = makeRequest(
      'http://localhost/api/invoices/inv-unpaid/refunds',
      {
        token: 'valid-token',
        body: { amount: 25, reason: 'Customer request' },
      },
    )

    const res = await POST(req, { params: { id: 'inv-unpaid' } })
    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.code).toBe('INVOICE_NOT_PAID')
    expect(mockRefundCreate).not.toHaveBeenCalled()
  })

  it('rejects a refund amount exceeding the paid amount minus prior pending/completed refunds', async () => {
    mockInvoiceFindUnique.mockResolvedValue({
      id: 'inv-1',
      userId: 'user-1',
      amount: 100,
      currency: 'USD',
      status: 'paid',
      paidAt: new Date('2026-04-01T10:00:00Z'),
    })

    // $40 completed + $25 pending = $65 already issued; $15 failed is ignored -> $35 remaining
    mockRefundFindMany.mockResolvedValue([
      { id: 'ref-1', invoiceId: 'inv-1', amount: 40, status: 'completed' },
      { id: 'ref-2', invoiceId: 'inv-1', amount: 25, status: 'pending' },
      { id: 'ref-3', invoiceId: 'inv-1', amount: 15, status: 'failed' },
    ])

    const req = makeRequest('http://localhost/api/invoices/inv-1/refunds', {
      token: 'valid-token',
      body: { amount: 40, reason: 'Over remaining balance' },
    })

    const res = await POST(req, { params: { id: 'inv-1' } })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.code).toBe('REFUND_EXCEEDS_PAID_BALANCE')
    expect(json.paidAmount).toBe(100)
    expect(json.priorRefundsTotal).toBe(65)
    expect(json.remainingRefundableAmount).toBe(35)
    expect(mockRefundCreate).not.toHaveBeenCalled()
  })

  it('issues a partial refund with status defaulted to pending when within remaining paid balance', async () => {
    const now = new Date('2026-04-02T10:00:00Z')
    mockInvoiceFindUnique.mockResolvedValue({
      id: 'inv-1',
      userId: 'user-1',
      amount: 100,
      currency: 'USD',
      status: 'paid',
      paidAt: now,
    })

    mockRefundFindMany.mockResolvedValue([
      { id: 'ref-1', invoiceId: 'inv-1', amount: 40, status: 'completed' },
    ])

    mockRefundCreate.mockImplementation(async ({ data }: any) => ({
      id: 'ref-new',
      ...data,
      createdAt: now,
      updatedAt: now,
    }))

    const req = makeRequest('http://localhost/api/invoices/inv-1/refunds', {
      token: 'valid-token',
      body: { amount: 60, reason: 'Remaining balance refund' },
    })

    const res = await POST(req, { params: { id: 'inv-1' } })
    expect(res.status).toBe(201)

    const json = await res.json()
    expect(json.refund.id).toBe('ref-new')
    expect(json.refund.amount).toBe(60)
    expect(json.refund.status).toBe('pending')
    expect(json.refund.reason).toBe('Remaining balance refund')
    expect(json.remainingRefundableAmount).toBe(0)

    expect(mockRefundCreate).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        invoiceId: 'inv-1',
        amount: 60,
        currency: 'USD',
        reason: 'Remaining balance refund',
        status: 'pending',
      },
    })
  })

  it('lists refunds and remaining refundable balance via GET', async () => {
    mockInvoiceFindUnique.mockResolvedValue({
      id: 'inv-1',
      userId: 'user-1',
      amount: 100,
      currency: 'USD',
      status: 'paid',
      paidAt: new Date('2026-04-01T10:00:00Z'),
    })
    mockRefundFindMany.mockResolvedValue([
      {
        id: 'ref-1',
        userId: 'user-1',
        invoiceId: 'inv-1',
        amount: 30,
        currency: 'USD',
        reason: 'Discount adjustment',
        status: 'pending',
        createdAt: new Date('2026-04-02T10:00:00Z'),
      },
    ])

    const req = makeRequest('http://localhost/api/invoices/inv-1/refunds', {
      method: 'GET',
      token: 'valid-token',
    })

    const res = await GET(req, { params: { id: 'inv-1' } })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.paidAmount).toBe(100)
    expect(json.priorRefundsTotal).toBe(30)
    expect(json.remainingRefundableAmount).toBe(70)
    expect(json.refunds).toHaveLength(1)
  })
})
