import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const findUnique = vi.fn()
const walletFindUnique = vi.fn()
const transactionCreate = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique },
    wallet: { findUnique: walletFindUnique },
    transaction: { create: transactionCreate },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

const URL = 'http://localhost/api/routes-d/payouts/instant'

function req(body: object, token: string | null = 'tok') {
  const h = new Headers({ 'content-type': 'application/json' })
  if (token) h.set('authorization', `Bearer ${token}`)
  return new NextRequest(URL, { method: 'POST', headers: h, body: JSON.stringify(body) })
}

describe('POST /api/routes-d/payouts/instant', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 with no token', async () => {
    const { POST } = await import('@/app/api/routes-d/payouts/instant/route')
    const res = await POST(req({}, null))
    expect(res.status).toBe(401)
  })

  it('returns 401 with invalid token', async () => {
    verifyAuthToken.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-d/payouts/instant/route')
    const res = await POST(req({}))
    expect(res.status).toBe(401)
  })

  it('returns 401 when user not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    findUnique.mockResolvedValue(null)
    const { POST } = await import('@/app/api/routes-d/payouts/instant/route')
    const res = await POST(req({ amount: 100, currency: 'USD', destinationId: 'bk_1' }))
    expect(res.status).toBe(401)
  })

  it('returns 422 when amount is missing', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    findUnique.mockResolvedValue({ id: 'user-1' })
    const { POST } = await import('@/app/api/routes-d/payouts/instant/route')
    const res = await POST(req({ currency: 'USD', destinationId: 'bk_1' }))
    expect(res.status).toBe(422)
  })

  it('creates payout and returns 201', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    findUnique.mockResolvedValue({ id: 'user-1' })
    walletFindUnique.mockResolvedValue({ id: 'wal-1' })
    transactionCreate.mockResolvedValue({
      id: 'tx-1', type: 'instant_payout', status: 'pending',
      amount: 100, currency: 'USD', createdAt: new Date(),
    })
    const { POST } = await import('@/app/api/routes-d/payouts/instant/route')
    const res = await POST(req({ amount: 100, currency: 'USD', destinationId: 'bk_1' }))
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.payout.status).toBe('pending')
  })
})
