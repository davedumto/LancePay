import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const transactionFindMany = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    transaction: { findMany: transactionFindMany },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

const URL = 'http://localhost/api/routes-d/wallet/pending'

function getReq() {
  return new NextRequest(URL, { headers: { authorization: 'Bearer tok' } })
}

describe('GET /api/routes-d/wallet/pending', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 when no auth token', async () => {
    const { GET } = await import('@/app/api/routes-d/wallet/pending/route')
    const res = await GET(new NextRequest(URL))
    expect(res.status).toBe(401)
  })

  it('returns 401 when token invalid', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-d/wallet/pending/route')
    const res = await GET(getReq())
    expect(res.status).toBe(401)
  })

  it('returns 401 when user not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(null)
    const { GET } = await import('@/app/api/routes-d/wallet/pending/route')
    const res = await GET(getReq())
    expect(res.status).toBe(401)
  })

  it('returns empty list when no pending transactions', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    transactionFindMany.mockResolvedValue([])
    const { GET } = await import('@/app/api/routes-d/wallet/pending/route')
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.pending).toHaveLength(0)
    expect(body.count).toBe(0)
    expect(body.totals).toEqual({})
  })

  it('returns pending transactions with totals grouped by currency', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    transactionFindMany.mockResolvedValue([
      { id: 'tx_1', type: 'deposit', amount: 100, currency: 'USDC', status: 'pending', createdAt: new Date(), expectedSettlementAt: null },
      { id: 'tx_2', type: 'deposit', amount: 50, currency: 'USDC', status: 'pending', createdAt: new Date(), expectedSettlementAt: null },
      { id: 'tx_3', type: 'withdrawal', amount: 200, currency: 'XLM', status: 'pending', createdAt: new Date(), expectedSettlementAt: null },
    ])
    const { GET } = await import('@/app/api/routes-d/wallet/pending/route')
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.count).toBe(3)
    expect(body.totals['USDC']).toBe(150)
    expect(body.totals['XLM']).toBe(200)
    expect(body.pending[0].id).toBe('tx_1')
  })
})
