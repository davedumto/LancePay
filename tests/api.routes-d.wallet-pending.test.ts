import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  verifyAuthToken: vi.fn(),
  userFindUnique: vi.fn(),
  walletFindUnique: vi.fn(),
  invoiceAggregate: vi.fn(),
  invoiceCount: vi.fn(),
  loggerError: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: mocks.verifyAuthToken,
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    wallet: { findUnique: mocks.walletFindUnique },
    invoice: { aggregate: mocks.invoiceAggregate, count: mocks.invoiceCount },
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: mocks.loggerError },
}))

import { GET } from '@/app/api/routes-d/wallet/pending/route'

const BASE_URL = 'http://localhost/api/routes-d/wallet/pending'

function makeRequest(token: string | null = 'valid-token') {
  const headers = new Headers()
  if (token) {
    headers.set('authorization', `Bearer ${token}`)
  }
  return new NextRequest(BASE_URL, { method: 'GET', headers })
}

describe('GET /api/routes-d/wallet/pending', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when the token is invalid', async () => {
    mocks.verifyAuthToken.mockResolvedValue(null)
    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
  })

  it('returns zero pending balances when the user has no wallet', async () => {
    mocks.verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    mocks.userFindUnique.mockResolvedValue({ id: 'user_1' })
    mocks.walletFindUnique.mockResolvedValue(null)

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      pending: { amount: 0, currency: 'USD', invoiceCount: 0 },
    })
  })

  it('returns pending invoice totals for the wallet owner', async () => {
    mocks.verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    mocks.userFindUnique.mockResolvedValue({ id: 'user_1' })
    mocks.walletFindUnique.mockResolvedValue({ id: 'wallet_1', address: 'GABC123' })
    mocks.invoiceAggregate.mockResolvedValue({ _sum: { amount: '125.50' } })
    mocks.invoiceCount.mockResolvedValue(3)

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      pending: { amount: 125.5, currency: 'USD', invoiceCount: 3 },
    })
    expect(mocks.invoiceAggregate).toHaveBeenCalledWith({
      where: { userId: 'user_1', status: 'pending' },
      _sum: { amount: true },
    })
  })

  it('returns 500 on unexpected database error', async () => {
    mocks.verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    mocks.userFindUnique.mockResolvedValue({ id: 'user_1' })
    mocks.walletFindUnique.mockRejectedValue(new Error('db unavailable'))

    const res = await GET(makeRequest())
    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({ error: 'Failed to get pending wallet balances' })
    expect(mocks.loggerError).toHaveBeenCalled()
  })
})
