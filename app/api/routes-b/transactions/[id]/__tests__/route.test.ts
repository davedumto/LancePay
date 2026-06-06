import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mockVerifyAuthToken = vi.hoisted(() => vi.fn())

vi.mock('@/lib/auth', () => ({ verifyAuthToken: mockVerifyAuthToken }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    transaction: { findUnique: vi.fn() },
  },
}))

import { prisma } from '@/lib/db'
import { GET } from '../route'

const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedTxFind = vi.mocked(prisma.transaction.findUnique)

const TX_ID = '11111111-1111-7111-8111-111111111111'

function makeGET(id = TX_ID, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost/api/routes-b/transactions/${id}`, {
    method: 'GET',
    headers: { authorization: 'Bearer token', ...headers },
  })
}

describe('GET /api/routes-b/transactions/[id]', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'privy-1' })
    mockedUserFind.mockResolvedValue({ id: 'user-1' } as never)
  })

  it('returns the transaction for its owner', async () => {
    mockedTxFind.mockResolvedValue({
      id: TX_ID,
      userId: 'user-1',
      type: 'payment',
      status: 'completed',
      amount: 250,
      currency: 'USDC',
      error: null,
      txHash: 'stellar-hash',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      invoice: { invoiceNumber: 'INV-42' },
    } as never)

    const res = await GET(makeGET(), { params: Promise.resolve({ id: TX_ID }) })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.transaction).toEqual({
      id: TX_ID,
      type: 'payment',
      status: 'completed',
      amount: 250,
      currency: 'USDC',
      description: 'Invoice INV-42 paid',
      stellarTxHash: 'stellar-hash',
      createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    })
  })

  it('returns 401 when auth token is missing', async () => {
    const req = new NextRequest(`http://localhost/api/routes-b/transactions/${TX_ID}`, {
      method: 'GET',
    })
    const res = await GET(req, { params: Promise.resolve({ id: TX_ID }) })
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toMatchObject({ code: 'UNAUTHORIZED', message: 'Unauthorized' })
  })

  it('returns 401 when auth token is invalid', async () => {
    mockVerifyAuthToken.mockResolvedValueOnce(null)
    const res = await GET(makeGET(), { params: Promise.resolve({ id: TX_ID }) })
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toMatchObject({ code: 'UNAUTHORIZED', message: 'Invalid token' })
  })

  it('returns 404 when user is not found', async () => {
    mockedUserFind.mockResolvedValueOnce(null)
    const res = await GET(makeGET(), { params: Promise.resolve({ id: TX_ID }) })
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error).toMatchObject({ code: 'NOT_FOUND', message: 'User not found' })
  })

  it('returns 404 when the transaction does not exist', async () => {
    mockedTxFind.mockResolvedValueOnce(null)
    const res = await GET(makeGET(), { params: Promise.resolve({ id: TX_ID }) })
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error).toMatchObject({ code: 'NOT_FOUND', message: 'Transaction not found' })
  })

  it('returns 404 when the transaction belongs to another user', async () => {
    mockedTxFind.mockResolvedValue({
      id: TX_ID,
      userId: 'user-2',
      type: 'payment',
      status: 'completed',
      amount: 100,
      currency: 'USDC',
      error: null,
      txHash: null,
      createdAt: new Date(),
      invoice: null,
    } as never)

    const res = await GET(makeGET(), { params: Promise.resolve({ id: TX_ID }) })
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error).toMatchObject({ code: 'NOT_FOUND', message: 'Transaction not found' })
  })

  it('returns 400 for an invalid transaction id', async () => {
    const res = await GET(makeGET('not-a-uuid'), { params: Promise.resolve({ id: 'not-a-uuid' }) })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Invalid transaction id',
      fields: { id: 'Must be a valid UUID' },
    })
  })

  it('returns structured error on unexpected failure', async () => {
    mockedUserFind.mockRejectedValueOnce(new Error('database unavailable'))
    const res = await GET(makeGET('tx-1', { 'x-request-id': 'req-error-1' }), {
      params: Promise.resolve({ id: TX_ID }),
    })
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.error).toMatchObject({
      code: 'INTERNAL',
      message: 'Failed to fetch transaction',
    })
    expect(json.requestId).toBeTruthy()
  })
})
