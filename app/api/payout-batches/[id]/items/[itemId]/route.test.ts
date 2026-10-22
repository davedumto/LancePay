import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    payoutBatch: { findUnique: vi.fn() },
    payoutItem: { findUnique: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const BATCH_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const OTHER_BATCH_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const ITEM_ID = 'iiiiiiii-iiii-4iii-8iii-iiiiiiiiiiii'
const USER_ID = 'uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu'
const OTHER_USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const mockBatch = {
  id: BATCH_ID,
  userId: USER_ID,
  status: 'completed',
  totalAmount: '500.00',
  totalRecipients: 2,
  successCount: 2,
  failedCount: 0,
  results: [],
  scheduledAt: null,
  createdAt: new Date('2026-09-01T10:00:00Z'),
  completedAt: new Date('2026-09-01T10:05:00Z'),
}

const mockItem = {
  id: ITEM_ID,
  batchId: BATCH_ID,
  recipientIdentifier: 'GBXXX...STELLAR',
  amount: '250.000000',
  payoutType: 'stellar',
  status: 'completed',
  txHash: 'abc123txhash',
  errorMessage: null,
  createdAt: new Date('2026-09-01T10:00:00Z'),
  updatedAt: new Date('2026-09-01T10:05:00Z'),
}

function makeRequest(batchId = BATCH_ID, itemId = ITEM_ID, token = 'user-token'): NextRequest {
  return new NextRequest(
    `http://localhost/api/payout-batches/${batchId}/items/${itemId}`,
    {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    },
  )
}

function makeContext(batchId = BATCH_ID, itemId = ITEM_ID) {
  return { params: Promise.resolve({ id: batchId, itemId }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-user' } as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: USER_ID } as any)
  vi.mocked(prisma.payoutBatch.findUnique).mockResolvedValue(mockBatch as any)
  vi.mocked(prisma.payoutItem.findUnique).mockResolvedValue(mockItem as any)
})

describe('GET /api/payout-batches/[id]/items/[itemId]', () => {
  // ── Happy path ────────────────────────────────────────────────────────────

  it('returns full item detail for the batch owner', async () => {
    const res = await GET(makeRequest(), makeContext())
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.item.id).toBe(ITEM_ID)
    expect(data.item.batchId).toBe(BATCH_ID)
    expect(data.item.payoutType).toBe('stellar')
    expect(data.item.status).toBe('completed')
    expect(data.item.txHash).toBe('abc123txhash')
    expect(data.item.errorMessage).toBeNull()
    expect(data.item.recipientIdentifier).toBe('GBXXX...STELLAR')
    expect(data.item.amount).toBe('250.000000')
  })

  it('includes all required fields in the response', async () => {
    const res = await GET(makeRequest(), makeContext())
    const data = await res.json()
    const fields = ['id', 'batchId', 'recipientIdentifier', 'amount', 'payoutType', 'status', 'txHash', 'errorMessage', 'createdAt', 'updatedAt']
    for (const field of fields) {
      expect(data.item).toHaveProperty(field)
    }
  })

  it('returns errorMessage when the item failed', async () => {
    vi.mocked(prisma.payoutItem.findUnique).mockResolvedValue({
      ...mockItem,
      status: 'failed',
      txHash: null,
      errorMessage: 'Recipient account not found',
    } as any)

    const res = await GET(makeRequest(), makeContext())
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.item.status).toBe('failed')
    expect(data.item.txHash).toBeNull()
    expect(data.item.errorMessage).toBe('Recipient account not found')
  })

  it('returns null txHash and null errorMessage for a pending item', async () => {
    vi.mocked(prisma.payoutItem.findUnique).mockResolvedValue({
      ...mockItem,
      status: 'pending',
      txHash: null,
      errorMessage: null,
    } as any)

    const res = await GET(makeRequest(), makeContext())
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.item.txHash).toBeNull()
    expect(data.item.errorMessage).toBeNull()
  })

  // ── Authentication ────────────────────────────────────────────────────────

  it('returns 401 when no authorization header is present', async () => {
    const req = new NextRequest(
      `http://localhost/api/payout-batches/${BATCH_ID}/items/${ITEM_ID}`,
      { method: 'GET' },
    )
    const res = await GET(req, makeContext())
    expect(res.status).toBe(401)
    const data = await res.json()
    expect(data.error).toBe('Unauthorized')
  })

  it('returns 401 when the token is invalid', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await GET(makeRequest(), makeContext())
    expect(res.status).toBe(401)
    const data = await res.json()
    expect(data.error).toBe('Unauthorized')
  })

  it('returns 401 when the user does not exist in the database', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
    const res = await GET(makeRequest(), makeContext())
    expect(res.status).toBe(401)
    const data = await res.json()
    expect(data.error).toBe('Unauthorized')
    expect(data.message).toBe('User not found')
  })

  // ── Batch not found ───────────────────────────────────────────────────────

  it('returns 404 when the batch does not exist', async () => {
    vi.mocked(prisma.payoutBatch.findUnique).mockResolvedValue(null)
    const res = await GET(makeRequest(), makeContext())
    expect(res.status).toBe(404)
    const data = await res.json()
    expect(data.error).toBe('Not Found')
    expect(data.message).toBe('Payout batch not found')
  })

  // ── Authorization ─────────────────────────────────────────────────────────

  it('returns 403 when the batch belongs to a different user', async () => {
    vi.mocked(prisma.payoutBatch.findUnique).mockResolvedValue({
      ...mockBatch,
      userId: OTHER_USER_ID,
    } as any)
    const res = await GET(makeRequest(), makeContext())
    expect(res.status).toBe(403)
    const data = await res.json()
    expect(data.error).toBe('Forbidden')
    expect(data.message).toBe('You do not own this payout batch')
  })

  it('does not fetch the item when authorization fails', async () => {
    vi.mocked(prisma.payoutBatch.findUnique).mockResolvedValue({
      ...mockBatch,
      userId: OTHER_USER_ID,
    } as any)
    await GET(makeRequest(), makeContext())
    expect(vi.mocked(prisma.payoutItem.findUnique)).not.toHaveBeenCalled()
  })

  // ── Item not found ────────────────────────────────────────────────────────

  it('returns 404 when the item does not exist at all', async () => {
    vi.mocked(prisma.payoutItem.findUnique).mockResolvedValue(null)
    const res = await GET(makeRequest(), makeContext())
    expect(res.status).toBe(404)
    const data = await res.json()
    expect(data.error).toBe('Not Found')
    expect(data.message).toBe('Payout item not found')
  })

  it('returns 404 when the item exists but belongs to a different batch', async () => {
    // Item exists in DB but its batchId does not match the [id] path param
    vi.mocked(prisma.payoutItem.findUnique).mockResolvedValue({
      ...mockItem,
      batchId: OTHER_BATCH_ID,
    } as any)
    const res = await GET(makeRequest(), makeContext())
    expect(res.status).toBe(404)
    const data = await res.json()
    expect(data.error).toBe('Not Found')
    expect(data.message).toBe('Payout item not found')
  })

  it('returns the same 404 shape whether item is missing or belongs to another batch', async () => {
    // Missing item
    vi.mocked(prisma.payoutItem.findUnique).mockResolvedValue(null)
    const res1 = await GET(makeRequest(), makeContext())
    const body1 = await res1.json()

    // Item in wrong batch
    vi.mocked(prisma.payoutItem.findUnique).mockResolvedValue({
      ...mockItem,
      batchId: OTHER_BATCH_ID,
    } as any)
    const res2 = await GET(makeRequest(), makeContext())
    const body2 = await res2.json()

    expect(res1.status).toBe(404)
    expect(res2.status).toBe(404)
    expect(body1.error).toBe('Not Found')
    expect(body2.error).toBe('Not Found')
    expect(body1.message).toBe('Payout item not found')
    expect(body2.message).toBe('Payout item not found')
  })

  it('looks up the item by itemId, not batch id', async () => {
    await GET(makeRequest(), makeContext())
    expect(vi.mocked(prisma.payoutItem.findUnique)).toHaveBeenCalledWith({
      where: { id: ITEM_ID },
    })
  })

  // ── Error handling ────────────────────────────────────────────────────────

  it('returns 500 when the database throws unexpectedly', async () => {
    vi.mocked(prisma.payoutItem.findUnique).mockRejectedValue(new Error('DB connection lost'))
    const res = await GET(makeRequest(), makeContext())
    expect(res.status).toBe(500)
    const data = await res.json()
    expect(data.error).toBe('Internal Server Error')
    expect(data.message).toBe('Failed to fetch payout item')
  })

  it('returns 500 when the batch query throws', async () => {
    vi.mocked(prisma.payoutBatch.findUnique).mockRejectedValue(new Error('timeout'))
    const res = await GET(makeRequest(), makeContext())
    expect(res.status).toBe(500)
    const data = await res.json()
    expect(data.error).toBe('Internal Server Error')
  })
})
