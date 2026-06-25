import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const transactionFindUnique = vi.fn()
const transactionUpdate = vi.fn()
const invoiceFindUnique = vi.fn()
const invoiceUpdate = vi.fn()
const transactionCallback = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    transaction: { findUnique: transactionFindUnique, update: transactionUpdate },
    invoice: { findUnique: invoiceFindUnique, update: invoiceUpdate },
    $transaction: transactionCallback,
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

function makeRequest(body?: unknown, token: string | null = 'valid-token') {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (token) headers.set('authorization', `Bearer ${token}`)
  return new NextRequest('http://localhost/api/routes-d/reconciliation/match', {
    method: 'POST',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

describe('POST /api/routes-d/reconciliation/match', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    transactionCallback.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        transaction: { update: transactionUpdate },
        invoice: { update: invoiceUpdate },
      }),
    )
  })

  it('returns 401 when not authenticated', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-d/reconciliation/match/route')
    const res = await POST(makeRequest({ transactionId: 'tx_1', invoiceId: 'inv_1' }, null))
    expect(res.status).toBe(401)
  })

  it('returns 404 when the transaction is not owned by the caller', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1', role: 'freelancer' })
    transactionFindUnique.mockResolvedValue({ id: 'tx_1', userId: 'user_other', invoiceId: null, status: 'completed', completedAt: null })

    const { POST } = await import('@/app/api/routes-d/reconciliation/match/route')
    const res = await POST(makeRequest({ transactionId: 'tx_1', invoiceId: 'inv_1' }))
    expect(res.status).toBe(404)
  })

  it('returns 409 when the transaction is already matched to another invoice', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1', role: 'freelancer' })
    transactionFindUnique.mockResolvedValue({ id: 'tx_1', userId: 'user_1', invoiceId: 'inv_other', status: 'completed', completedAt: null })
    invoiceFindUnique.mockResolvedValue({ id: 'inv_1', userId: 'user_1', transaction: null, status: 'pending', paidAt: null })

    const { POST } = await import('@/app/api/routes-d/reconciliation/match/route')
    const res = await POST(makeRequest({ transactionId: 'tx_1', invoiceId: 'inv_1' }))
    expect(res.status).toBe(409)
  })

  it('matches the transaction to the invoice', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1', role: 'freelancer' })
    transactionFindUnique.mockResolvedValue({ id: 'tx_1', userId: 'user_1', invoiceId: null, status: 'completed', completedAt: null })
    invoiceFindUnique.mockResolvedValue({ id: 'inv_1', userId: 'user_1', transaction: null, status: 'pending', paidAt: null })
    transactionUpdate.mockResolvedValue({ id: 'tx_1' })
    invoiceUpdate.mockResolvedValue({ id: 'inv_1' })

    const { POST } = await import('@/app/api/routes-d/reconciliation/match/route')
    const res = await POST(makeRequest({ transactionId: 'tx_1', invoiceId: 'inv_1' }))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.match).toMatchObject({ transactionId: 'tx_1', invoiceId: 'inv_1' })
    expect(transactionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tx_1' },
        data: expect.objectContaining({ invoiceId: 'inv_1', status: 'completed' }),
      }),
    )
    expect(invoiceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'inv_1' },
        data: expect.objectContaining({ status: 'paid' }),
      }),
    )
  })
})
