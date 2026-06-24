import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    transaction: { findUnique: vi.fn() },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const userDelegate = prisma.user as unknown as { findUnique: ReturnType<typeof vi.fn> }
const txDelegate = prisma.transaction as unknown as { findUnique: ReturnType<typeof vi.fn> }

const BASE_URL = 'http://localhost/api/routes-d/transactions'

function makeGet(id: string, authHeader: string | null = 'Bearer token') {
  return new NextRequest(`${BASE_URL}/${id}/receipt`, {
    method: 'GET',
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

const TX_ID = 'tx-uuid-1'
const PARAMS = { params: { id: TX_ID } }

const mockUser = { id: 'user-1', privyId: 'privy-1' }
const mockTransaction = {
  id: TX_ID,
  userId: 'user-1',
  type: 'payment',
  status: 'completed',
  amount: { toString: () => '100.00' },
  currency: 'USD',
  txHash: '0xabc123',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  completedAt: new Date('2026-01-01T01:00:00Z'),
}

describe('GET /api/routes-d/transactions/[id]/receipt', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns 401 when no auth header', async () => {
    const res = await GET(makeGet(TX_ID, null), PARAMS)
    expect(res.status).toBe(401)
  })

  it('returns 401 when token invalid', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await GET(makeGet(TX_ID), PARAMS)
    expect(res.status).toBe(401)
  })

  it('returns 404 when user not found', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    userDelegate.findUnique.mockResolvedValue(null)
    const res = await GET(makeGet(TX_ID), PARAMS)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('User not found')
  })

  it('returns 400 when transaction ID is empty', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    userDelegate.findUnique.mockResolvedValue({ id: 'user-1' })
    const res = await GET(makeGet(''), { params: { id: '' } })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Transaction ID is required')
  })

  it('returns 404 when transaction not found', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    userDelegate.findUnique.mockResolvedValue(mockUser)
    txDelegate.findUnique.mockResolvedValue(null)
    const res = await GET(makeGet(TX_ID), PARAMS)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('Transaction not found')
  })

  it('returns 403 when transaction belongs to another user', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    userDelegate.findUnique.mockResolvedValue(mockUser)
    txDelegate.findUnique.mockResolvedValue({ ...mockTransaction, userId: 'other-user' })
    const res = await GET(makeGet(TX_ID), PARAMS)
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('Forbidden')
  })

  it('returns 200 with receipt for valid request', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    userDelegate.findUnique.mockResolvedValue(mockUser)
    txDelegate.findUnique.mockResolvedValue(mockTransaction)
    const res = await GET(makeGet(TX_ID), PARAMS)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.receipt).toBeDefined()
  })

  it('receipt contains expected fields', async () => {
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    userDelegate.findUnique.mockResolvedValue(mockUser)
    txDelegate.findUnique.mockResolvedValue(mockTransaction)
    const res = await GET(makeGet(TX_ID), PARAMS)
    const body = await res.json()
    const { receipt } = body
    expect(receipt.id).toBe(TX_ID)
    expect(receipt.type).toBe('payment')
    expect(receipt.status).toBe('completed')
    expect(receipt.amount).toBe('100.00')
    expect(receipt.currency).toBe('USD')
    expect(receipt.createdAt).toBeDefined()
    expect(receipt.reference).toBe(TX_ID)
  })
})
