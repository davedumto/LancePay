import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { Decimal } from '@prisma/client/runtime/library'
import { GET, POST } from './route'

const transaction = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    invoice: { findFirst: vi.fn() },
    refund: { findMany: vi.fn(), aggregate: vi.fn(), create: vi.fn() },
    $transaction: transaction,
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const userFind = vi.mocked(prisma.user.findUnique)
const invoiceFind = vi.mocked(prisma.invoice.findFirst)
const refundFindMany = vi.mocked(prisma.refund.findMany)
const refundAggregate = vi.mocked(prisma.refund.aggregate)
const refundCreate = vi.mocked(prisma.refund.create)

function request(method: 'GET' | 'POST', body?: unknown, token = 'valid') {
  return new NextRequest('http://localhost/api/invoices/inv-1/refunds', {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
    },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  })
}

function params() {
  return { params: Promise.resolve({ id: 'inv-1' }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
  userFind.mockResolvedValue({ id: 'user-1' } as never)
  invoiceFind.mockResolvedValue({
    id: 'inv-1',
    currency: 'USD',
    transaction: { amount: new Decimal(100), status: 'completed' },
    manualPayments: [],
  } as never)
  refundFindMany.mockResolvedValue([] as never)
  refundAggregate.mockResolvedValue({ _sum: { amount: null } } as never)
  refundCreate.mockResolvedValue({
    id: 'refund-1', invoiceId: 'inv-1', amount: { toNumber: () => 40 }, currency: 'USD',
    reason: 'Customer request', status: 'pending', createdAt: new Date('2026-10-01T00:00:00Z'),
  } as never)
  transaction.mockImplementation((callback: (tx: unknown) => Promise<unknown>) =>
    callback({ refund: { aggregate: refundAggregate, create: refundCreate } }),
  )
})

describe('/api/invoices/[id]/refunds', () => {
  it('lists an invoice refunds', async () => {
    const response = await GET(request('GET'), params())
    expect(response.status).toBe(200)
    expect((await response.json()).refunds).toEqual([])
  })

  it('creates a pending refund for an amount within the paid balance', async () => {
    const response = await POST(request('POST', { amount: 40, reason: ' Customer request ' }), params())
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(body.refund).toMatchObject({ id: 'refund-1', status: 'pending', amount: 40 })
    expect(refundCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ amount: expect.anything(), status: 'pending', reason: 'Customer request' }),
    }))
  })

  it('rejects an amount greater than paid funds remaining after earlier refunds', async () => {
    refundAggregate.mockResolvedValue({ _sum: { amount: new Decimal(70) } } as never)
    const response = await POST(request('POST', { amount: 40, reason: 'Customer request' }), params())

    expect(response.status).toBe(400)
    expect(refundCreate).not.toHaveBeenCalled()
  })

  it('rejects a missing reason', async () => {
    const response = await POST(request('POST', { amount: 10, reason: '   ' }), params())
    expect(response.status).toBe(400)
    expect(refundCreate).not.toHaveBeenCalled()
  })

  it('rejects unauthenticated requests', async () => {
    const response = await GET(new NextRequest('http://localhost/api/invoices/inv-1/refunds'), params())
    expect(response.status).toBe(401)
  })
})