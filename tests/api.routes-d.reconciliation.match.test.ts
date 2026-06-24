import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const transactionFindUnique = vi.fn()
const transactionFindFirst = vi.fn()
const invoiceFindUnique = vi.fn()
const prismaTransaction = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    transaction: { findUnique: transactionFindUnique, findFirst: transactionFindFirst },
    invoice: { findUnique: invoiceFindUnique },
    $transaction: prismaTransaction,
  },
}))

const BASE_URL = 'http://localhost/api/routes-d/reconciliation/match'

function makeRequest(body?: unknown, opts?: { auth?: string }) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const auth = opts?.auth ?? 'Bearer token'
  if (auth) headers.authorization = auth
  return new NextRequest(BASE_URL, {
    method: 'POST',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

const validBody = {
  transactionId: 'tx_123',
  invoiceId: 'inv_456',
}

describe('POST /api/routes-d/reconciliation/match', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when no auth is supplied', async () => {
    const { POST } = await import('@/app/api/routes-d/reconciliation/match/route')
    const res = await POST(makeRequest(validBody, { auth: '' }))
    expect(res.status).toBe(401)
  })

  it('returns 404 when transaction is not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    transactionFindUnique.mockResolvedValue(null)

    const { POST } = await import('@/app/api/routes-d/reconciliation/match/route')
    const res = await POST(makeRequest(validBody))
    expect(res.status).toBe(404)
  })

  it('returns 403 when transaction belongs to another user', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    transactionFindUnique.mockResolvedValue({ id: 'tx_123', userId: 'user_other' })

    const { POST } = await import('@/app/api/routes-d/reconciliation/match/route')
    const res = await POST(makeRequest(validBody))
    expect(res.status).toBe(403)
  })

  it('returns 404 when invoice is not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    transactionFindUnique.mockResolvedValue({ id: 'tx_123', userId: 'user_1' })
    invoiceFindUnique.mockResolvedValue(null)

    const { POST } = await import('@/app/api/routes-d/reconciliation/match/route')
    const res = await POST(makeRequest(validBody))
    expect(res.status).toBe(404)
  })

  it('returns 403 when invoice belongs to another user', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    transactionFindUnique.mockResolvedValue({ id: 'tx_123', userId: 'user_1' })
    invoiceFindUnique.mockResolvedValue({ id: 'inv_456', userId: 'user_other' })

    const { POST } = await import('@/app/api/routes-d/reconciliation/match/route')
    const res = await POST(makeRequest(validBody))
    expect(res.status).toBe(403)
  })

  it('returns 409 when transaction is already matched', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    transactionFindUnique.mockResolvedValue({ id: 'tx_123', userId: 'user_1', invoiceId: 'inv_already_matched' })
    invoiceFindUnique.mockResolvedValue({ id: 'inv_456', userId: 'user_1' })

    const { POST } = await import('@/app/api/routes-d/reconciliation/match/route')
    const res = await POST(makeRequest(validBody))
    expect(res.status).toBe(409)
  })

  it('returns 409 when invoice is already matched to another transaction', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    transactionFindUnique.mockResolvedValue({ id: 'tx_123', userId: 'user_1', invoiceId: null })
    invoiceFindUnique.mockResolvedValue({ id: 'inv_456', userId: 'user_1' })
    transactionFindFirst.mockResolvedValue({ id: 'tx_other', invoiceId: 'inv_456' })

    const { POST } = await import('@/app/api/routes-d/reconciliation/match/route')
    const res = await POST(makeRequest(validBody))
    expect(res.status).toBe(409)
  })

  it('returns 200 and performs transaction match successfully', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    transactionFindUnique.mockResolvedValue({ id: 'tx_123', userId: 'user_1', invoiceId: null, status: 'completed', completedAt: new Date('2026-06-24T00:00:00Z') })
    invoiceFindUnique.mockResolvedValue({ id: 'inv_456', userId: 'user_1', status: 'pending' })
    transactionFindFirst.mockResolvedValue(null)

    const mockTx = { id: 'tx_123', invoiceId: 'inv_456' }
    const mockInv = { id: 'inv_456', status: 'paid', paidAt: new Date('2026-06-24T00:00:00Z') }
    prismaTransaction.mockResolvedValue([mockTx, mockInv])

    const { POST } = await import('@/app/api/routes-d/reconciliation/match/route')
    const res = await POST(makeRequest(validBody))
    expect(res.status).toBe(200)

    const data = await res.json()
    expect(data.success).toBe(true)
    expect(prismaTransaction).toHaveBeenCalled()
  })
})
