import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const userCreate = vi.fn()
const walletFindUnique = vi.fn()
const getAccountBalance = vi.fn()
const payoutBatchFindMany = vi.fn()
const payoutBatchCreate = vi.fn()
const payoutItemCreate = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/stellar', () => ({ getAccountBalance }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique, create: userCreate },
    wallet: { findUnique: walletFindUnique },
    payoutBatch: { findMany: payoutBatchFindMany, create: payoutBatchCreate },
    payoutItem: { create: payoutItemCreate },
  },
}))

const BASE_URL = 'http://localhost/api/routes-d/payouts/schedule'

function makeGetRequest(authHeader = 'Bearer token') {
  return new NextRequest(BASE_URL, {
    method: 'GET',
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

function makePostRequest(body: unknown, authHeader = 'Bearer token') {
  return new NextRequest(BASE_URL, {
    method: 'POST',
    headers: authHeader
      ? { 'content-type': 'application/json', authorization: authHeader }
      : { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('Schedule Payouts Endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_USDC_ISSUER = 'G-USDC'
  })

  describe('GET /api/routes-d/payouts/schedule', () => {
    it('returns 401 when unauthorized', async () => {
      const { GET } = await import('@/app/api/routes-d/payouts/schedule/route')
      const res = await GET(makeGetRequest(''))
      expect(res.status).toBe(401)
    })

    it('returns 200 with scheduled batches for user', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
      userFindUnique.mockResolvedValue({ id: 'user_1' })
      payoutBatchFindMany.mockResolvedValue([
        {
          id: 'batch_1',
          userId: 'user_1',
          totalAmount: 100,
          status: 'scheduled',
          items: [{ id: 'item_1', recipientIdentifier: 'G-RECIP' }],
        },
      ])

      const { GET } = await import('@/app/api/routes-d/payouts/schedule/route')
      const res = await GET(makeGetRequest())
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.batches).toHaveLength(1)
      expect(body.batches[0].id).toBe('batch_1')
    })
  })

  describe('POST /api/routes-d/payouts/schedule', () => {
    const validBody = {
      items: [{ amount: '10', recipient: 'G-RECIP', type: 'USDC' }],
      scheduledFor: new Date(Date.now() + 86400000).toISOString(),
    }

    it('returns 401 when unauthorized', async () => {
      const { POST } = await import('@/app/api/routes-d/payouts/schedule/route')
      const res = await POST(makePostRequest(validBody, ''))
      expect(res.status).toBe(401)
    })

    it('returns 400 for empty items array', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
      userFindUnique.mockResolvedValue({ id: 'user_1' })

      const { POST } = await import('@/app/api/routes-d/payouts/schedule/route')
      const res = await POST(makePostRequest({ items: [], scheduledFor: validBody.scheduledFor }))
      expect(res.status).toBe(400)
    })

    it('returns 400 for past date scheduledFor', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
      userFindUnique.mockResolvedValue({ id: 'user_1' })

      const { POST } = await import('@/app/api/routes-d/payouts/schedule/route')
      const res = await POST(
        makePostRequest({
          items: validBody.items,
          scheduledFor: new Date(Date.now() - 1000).toISOString(),
        }),
      )
      expect(res.status).toBe(400)
    })

    it('schedules payout batches successfully', async () => {
      verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
      userFindUnique.mockResolvedValue({ id: 'user_1' })
      walletFindUnique.mockResolvedValue({ address: 'G-SENDER-WALLET' })
      getAccountBalance.mockResolvedValue([
        { asset_code: 'USDC', asset_issuer: 'G-USDC', balance: '500' },
      ])
      payoutBatchCreate.mockResolvedValue({ id: 'batch_2' })

      const { POST } = await import('@/app/api/routes-d/payouts/schedule/route')
      const res = await POST(makePostRequest(validBody))
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.success).toBe(true)
      expect(body.batchId).toBe('batch_2')
      expect(payoutBatchCreate).toHaveBeenCalled()
    })
  })
})
