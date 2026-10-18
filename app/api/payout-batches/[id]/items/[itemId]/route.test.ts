import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockPrisma = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn(),
  },
  payoutBatch: {
    findUnique: vi.fn(),
  },
  payoutItem: {
    findUnique: vi.fn(),
  },
}))

const mockVerifyAuthToken = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: mockVerifyAuthToken }))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { GET } from './route'

describe('GET /api/payout-batches/[id]/items/[itemId]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue({ userId: 'did:privy:owner_1' })
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user_owner_1' })
  })

  it('restricts visibility to the batch owner and rejects non-owners with 403', async () => {
    mockPrisma.payoutBatch.findUnique.mockResolvedValue({
      id: 'batch_1',
      userId: 'other_user_99',
      status: 'processing',
      results: [],
    })

    const req = new NextRequest(
      'http://localhost/api/payout-batches/batch_1/items/item_1',
      {
        method: 'GET',
        headers: { authorization: 'Bearer valid_token' },
      },
    )

    const res = await GET(req, { params: { id: 'batch_1', itemId: 'item_1' } })
    expect(res.status).toBe(403)
    expect(mockPrisma.payoutItem.findUnique).not.toHaveBeenCalled()
  })

  it('returns 404 distinctly when the item exists but belongs to a different batch than the one in the path', async () => {
    mockPrisma.payoutBatch.findUnique.mockResolvedValue({
      id: 'batch_1',
      userId: 'user_owner_1',
      status: 'processing',
      results: [],
    })

    // Item exists, but belongs to batch_2 instead of batch_1
    mockPrisma.payoutItem.findUnique.mockResolvedValueOnce({
      id: 'item_in_other_batch',
      batchId: 'batch_2',
      recipientIdentifier: 'GDEST123456',
      amount: '150.000000',
      payoutType: 'stellar',
      status: 'success',
      txHash: 'tx_abc',
      errorMessage: null,
      createdAt: new Date('2026-06-05T10:00:00.000Z'),
      updatedAt: new Date('2026-06-05T10:01:00.000Z'),
    })

    const mismatchReq = new NextRequest(
      'http://localhost/api/payout-batches/batch_1/items/item_in_other_batch',
      {
        method: 'GET',
        headers: { authorization: 'Bearer valid_token' },
      },
    )

    const mismatchRes = await GET(mismatchReq, {
      params: { id: 'batch_1', itemId: 'item_in_other_batch' },
    })
    expect(mismatchRes.status).toBe(404)
    const mismatchBody = await mismatchRes.json()
    expect(mismatchBody.code).toBe('PAYOUT_ITEM_BATCH_MISMATCH')

    // Compare with non-existent item -> PAYOUT_ITEM_NOT_FOUND
    mockPrisma.payoutItem.findUnique.mockResolvedValueOnce(null)
    const missingReq = new NextRequest(
      'http://localhost/api/payout-batches/batch_1/items/item_nonexistent',
      {
        method: 'GET',
        headers: { authorization: 'Bearer valid_token' },
      },
    )
    const missingRes = await GET(missingReq, {
      params: { id: 'batch_1', itemId: 'item_nonexistent' },
    })
    expect(missingRes.status).toBe(404)
    const missingBody = await missingRes.json()
    expect(missingBody.code).toBe('PAYOUT_ITEM_NOT_FOUND')
  })

  it('includes payoutType and status alongside txHash and error detail history', async () => {
    mockPrisma.payoutBatch.findUnique.mockResolvedValue({
      id: 'batch_1',
      userId: 'user_owner_1',
      status: 'failed',
      results: [
        {
          itemId: 'item_failed_1',
          error: 'op_no_trust: recipient lacks USDC trustline',
          timestamp: '2026-06-05T10:00:30.000Z',
        },
      ],
    })

    mockPrisma.payoutItem.findUnique.mockResolvedValue({
      id: 'item_failed_1',
      batchId: 'batch_1',
      recipientIdentifier: 'GDEST999888',
      amount: '420.500000',
      payoutType: 'stellar',
      status: 'failed',
      txHash: null,
      errorMessage: 'Horizon tx_failed: op_underfunded on retry #1',
      createdAt: new Date('2026-06-05T10:00:00.000Z'),
      updatedAt: new Date('2026-06-05T10:05:00.000Z'),
    })

    const req = new NextRequest(
      'http://localhost/api/payout-batches/batch_1/items/item_failed_1',
      {
        method: 'GET',
        headers: { authorization: 'Bearer valid_token' },
      },
    )

    const res = await GET(req, {
      params: { id: 'batch_1', itemId: 'item_failed_1' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.payoutType).toBe('stellar')
    expect(body.status).toBe('failed')
    expect(body.item).toMatchObject({
      id: 'item_failed_1',
      batchId: 'batch_1',
      recipientIdentifier: 'GDEST999888',
      amount: '420.500000',
      payoutType: 'stellar',
      status: 'failed',
      txHash: null,
      errorMessage: 'Horizon tx_failed: op_underfunded on retry #1',
    })
    expect(body.item.errorHistory).toHaveLength(2)
    expect(body.item.errorDetail).toEqual({
      latestError: 'Horizon tx_failed: op_underfunded on retry #1',
      history: [
        {
          message: 'op_no_trust: recipient lacks USDC trustline',
          recordedAt: '2026-06-05T10:00:30.000Z',
          source: 'batch_results',
        },
        {
          message: 'Horizon tx_failed: op_underfunded on retry #1',
          recordedAt: '2026-06-05T10:05:00.000Z',
          source: 'item_record',
        },
      ],
    })
  })
})
