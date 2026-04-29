import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { findUnique: vi.fn() },
    auditEvent: { findMany: vi.fn(), create: vi.fn() },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { POST } from '../[id]/refund/route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFindUnique = vi.mocked(prisma.user.findUnique)
const mockedInvoiceFindUnique = vi.mocked(prisma.invoice.findUnique)
const mockedAuditFindMany = vi.mocked(prisma.auditEvent.findMany)
const mockedAuditCreate = vi.mocked(prisma.auditEvent.create)

const fakeUser = { id: 'user-1', privyId: 'privy-1' }

const paidInvoice = {
  id: 'inv-1',
  userId: 'user-1',
  status: 'paid',
  amount: 100,
  currency: 'USD',
}

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/routes-b/invoices/inv-1/refund', {
    method: 'POST',
    headers: { authorization: 'Bearer token' },
    body: JSON.stringify(body),
  })
}

const params = { params: Promise.resolve({ id: 'inv-1' }) }

describe('POST /api/routes-b/invoices/[id]/refund', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFindUnique.mockResolvedValue(fakeUser as never)
    mockedInvoiceFindUnique.mockResolvedValue(paidInvoice as never)
    mockedAuditFindMany.mockResolvedValue([] as never)
    mockedAuditCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      ({
        id: 'audit-1',
        ...data,
        createdAt: new Date('2026-04-29T00:00:00.000Z'),
      } as never),
    )
  })

  it('processes a full refund on a paid invoice', async () => {
    const res = await POST(makeRequest({ amount: 100, reason: 'customer satisfaction' }), params)
    const json = await res.json()

    expect(res.status).toBe(201)
    expect(json.refund.amount).toBe(100)
    expect(json.totalRefunded).toBe(100)
    expect(json.remainingRefundable).toBe(0)
    expect(mockedAuditCreate).toHaveBeenCalledOnce()
    expect(mockedAuditCreate.mock.calls[0][0].data).toMatchObject({
      eventType: 'invoice.refunded',
      actorId: 'user-1',
      invoiceId: 'inv-1',
    })
  })

  it('processes a partial refund and reports remaining', async () => {
    const res = await POST(makeRequest({ amount: 30, reason: 'partial' }), params)
    const json = await res.json()

    expect(res.status).toBe(201)
    expect(json.totalRefunded).toBe(30)
    expect(json.remainingRefundable).toBe(70)
  })

  it('stacks a second partial refund on top of the first', async () => {
    mockedAuditFindMany.mockResolvedValue([{ metadata: { amount: 30 } }] as never)

    const res = await POST(makeRequest({ amount: 25, reason: 'second partial' }), params)
    const json = await res.json()

    expect(res.status).toBe(201)
    expect(json.totalRefunded).toBe(55)
    expect(json.remainingRefundable).toBe(45)
  })

  it('rejects a refund that would exceed the remaining refundable', async () => {
    mockedAuditFindMany.mockResolvedValue([{ metadata: { amount: 80 } }] as never)

    const res = await POST(makeRequest({ amount: 25, reason: 'too much' }), params)
    const json = await res.json()

    expect(res.status).toBe(422)
    expect(json.code).toBe('REFUND_EXCEEDS_REMAINING')
    expect(json.remainingRefundable).toBe(20)
    expect(mockedAuditCreate).not.toHaveBeenCalled()
  })

  it('rejects a refund on an unpaid invoice', async () => {
    mockedInvoiceFindUnique.mockResolvedValue({ ...paidInvoice, status: 'pending' } as never)

    const res = await POST(makeRequest({ amount: 10, reason: 'nope' }), params)
    const json = await res.json()

    expect(res.status).toBe(422)
    expect(json.code).toBe('INVOICE_NOT_PAID')
    expect(mockedAuditCreate).not.toHaveBeenCalled()
  })

  it('rejects when amount is missing or non-positive', async () => {
    const noAmount = await POST(makeRequest({ reason: 'x' }), params)
    expect(noAmount.status).toBe(400)

    const zero = await POST(makeRequest({ amount: 0, reason: 'x' }), params)
    expect(zero.status).toBe(400)

    const negative = await POST(makeRequest({ amount: -1, reason: 'x' }), params)
    expect(negative.status).toBe(400)
  })

  it('rejects when reason is missing or too long', async () => {
    const noReason = await POST(makeRequest({ amount: 10 }), params)
    expect(noReason.status).toBe(400)

    const empty = await POST(makeRequest({ amount: 10, reason: '   ' }), params)
    expect(empty.status).toBe(400)

    const tooLong = await POST(makeRequest({ amount: 10, reason: 'x'.repeat(501) }), params)
    expect(tooLong.status).toBe(400)
  })

  it('returns 403 when invoice belongs to another user', async () => {
    mockedInvoiceFindUnique.mockResolvedValue({ ...paidInvoice, userId: 'other-user' } as never)

    const res = await POST(makeRequest({ amount: 10, reason: 'x' }), params)
    expect(res.status).toBe(403)
  })

  it('returns 404 when invoice does not exist', async () => {
    mockedInvoiceFindUnique.mockResolvedValue(null as never)

    const res = await POST(makeRequest({ amount: 10, reason: 'x' }), params)
    expect(res.status).toBe(404)
  })

  it('returns 401 when auth token is invalid', async () => {
    mockedVerify.mockResolvedValue(null as never)

    const res = await POST(makeRequest({ amount: 10, reason: 'x' }), params)
    expect(res.status).toBe(401)
  })
})
