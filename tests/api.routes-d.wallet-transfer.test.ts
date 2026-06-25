import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const findUnique = vi.fn()
const transactionCreate = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique },
    transaction: { create: transactionCreate },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))

const URL = 'http://localhost/api/routes-d/wallet/transfer'

function req(body: object) {
  return new NextRequest(URL, {
    method: 'POST',
    headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/routes-d/wallet/transfer', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 401 with no token', async () => {
    const { POST } = await import('@/app/api/routes-d/wallet/transfer/route')
    const res = await POST(new NextRequest(URL, { method: 'POST' }))
    expect(res.status).toBe(401)
  })

  it('returns 422 when buckets are the same', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    findUnique.mockResolvedValue({ id: 'user-1' })
    const { POST } = await import('@/app/api/routes-d/wallet/transfer/route')
    const res = await POST(req({ fromBucket: 'savings', toBucket: 'savings', amount: 100, currency: 'USD' }))
    expect(res.status).toBe(422)
  })

  it('returns 422 for invalid bucket', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    findUnique.mockResolvedValue({ id: 'user-1' })
    const { POST } = await import('@/app/api/routes-d/wallet/transfer/route')
    const res = await POST(req({ fromBucket: 'unknown', toBucket: 'savings', amount: 100, currency: 'USD' }))
    expect(res.status).toBe(422)
  })

  it('creates transfer and returns 201', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'u1' })
    findUnique.mockResolvedValue({ id: 'user-1' })
    transactionCreate.mockResolvedValue({
      id: 'tx-1', type: 'internal_transfer', status: 'completed',
      amount: 500, currency: 'USD', createdAt: new Date(),
    })
    const { POST } = await import('@/app/api/routes-d/wallet/transfer/route')
    const res = await POST(req({ fromBucket: 'operating', toBucket: 'savings', amount: 500, currency: 'USD' }))
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.transfer.status).toBe('completed')
  })
})
