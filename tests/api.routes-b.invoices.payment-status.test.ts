import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const invoiceFindFirst = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    invoice: { findFirst: invoiceFindFirst },
  },
}))

const BASE_URL = 'http://localhost/api/routes-b/invoices/inv_1/payment-status'

function makeRequest(headers: Record<string, string> = {}) {
  return new NextRequest(BASE_URL, {
    method: 'GET',
    headers: { authorization: 'Bearer token', ...headers },
  })
}

async function callGet(invoiceId = 'inv_1') {
  const { GET } = await import(
    '@/app/api/routes-b/invoices/[id]/payment-status/route'
  )
  return GET(makeRequest(), { params: Promise.resolve({ id: invoiceId }) })
}

describe('GET /api/routes-b/invoices/[id]/payment-status (#697)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when the bearer token is invalid', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const res = await callGet()
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'UNAUTHORIZED' })
  })

  it('returns 401 when the user does not exist in the DB', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_missing' })
    userFindUnique.mockResolvedValue(null)
    const res = await callGet()
    expect(res.status).toBe(401)
  })

  it('returns 404 when the invoice is not owned or shared with the caller', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindFirst.mockResolvedValueOnce(null) // owned lookup
    invoiceFindFirst.mockResolvedValueOnce(null) // collaborator lookup
    const res = await callGet('inv_unknown')
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: 'NOT_FOUND' })
  })

  it('returns the payment status payload for an owned, paid invoice', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindFirst.mockResolvedValueOnce({
      id: 'inv_1',
      status: 'paid',
      paymentLink: 'https://pay.test/inv_1',
      amount: 250 as any,
      currency: 'USD',
      dueDate: new Date('2026-06-15T00:00:00Z'),
      paidAt: new Date('2026-06-10T12:00:00Z'),
      transaction: {
        id: 'tx_1',
        status: 'settled',
        amount: 250 as any,
        settledAt: new Date('2026-06-10T12:30:00Z'),
      },
    })
    const res = await callGet()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      invoiceId: 'inv_1',
      status: 'paid',
      isTerminal: true,
      amountDue: 250,
      currency: 'USD',
      transaction: { id: 'tx_1', status: 'settled', amount: 250 },
    })
    expect(body.paidAt).toBe('2026-06-10T12:00:00.000Z')
  })

  it('classifies pending invoices as non-terminal and emits null transaction', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    invoiceFindFirst.mockResolvedValueOnce({
      id: 'inv_2',
      status: 'pending',
      paymentLink: 'https://pay.test/inv_2',
      amount: 100 as any,
      currency: 'USD',
      dueDate: null,
      paidAt: null,
      transaction: null,
    })
    const res = await callGet('inv_2')
    const body = await res.json()
    expect(body.status).toBe('pending')
    expect(body.isTerminal).toBe(false)
    expect(body.transaction).toBeNull()
    expect(body.dueDate).toBeNull()
  })

  it('falls back to the collaborator lookup when the caller does not own the invoice', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_collab' })
    userFindUnique.mockResolvedValue({ id: 'user_collab' })
    invoiceFindFirst.mockResolvedValueOnce(null) // not owner
    invoiceFindFirst.mockResolvedValueOnce({
      id: 'inv_shared',
      status: 'partially_paid',
      paymentLink: 'https://pay.test/inv_shared',
      amount: 400 as any,
      currency: 'USD',
      dueDate: new Date('2026-07-01T00:00:00Z'),
      paidAt: null,
      transaction: null,
    })
    const res = await callGet('inv_shared')
    expect(res.status).toBe(200)
    expect(invoiceFindFirst).toHaveBeenCalledTimes(2)
    expect(await res.json()).toMatchObject({ invoiceId: 'inv_shared', status: 'partially_paid', isTerminal: false })
  })
})
