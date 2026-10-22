import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from './route'

vi.mock('@/lib/db', () => {
  const tx = {
    payoutItem: { updateMany: vi.fn() },
    payoutBatch: { updateMany: vi.fn() },
  }
  return {
    prisma: {
      user: { findUnique: vi.fn() },
      payoutBatch: { findFirst: vi.fn() },
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
      __tx: tx,
    },
  }
})
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const tx = (prisma as any).__tx
const OWNER = '11111111-1111-4111-8111-111111111111'
const BATCH = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function request(body: unknown = { reason: 'Wrong recipient list uploaded' }, token: string | null = 'owner-token') {
  return new NextRequest(`http://localhost/api/payout-batches/${BATCH}/cancel`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const context = (id = BATCH) => ({ params: Promise.resolve({ id }) })

const processingBatch = {
  id: BATCH,
  userId: OWNER,
  status: 'processing',
  totalRecipients: 5,
  successCount: 2,
  failedCount: 1,
  completedAt: null,
  cancelledAt: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockImplementation((async (token: string) =>
    token === 'owner-token' ? { userId: 'privy-owner' } : null) as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: OWNER, role: 'freelancer' } as any)
  vi.mocked(prisma.payoutBatch.findFirst).mockResolvedValue(processingBatch as any)
  tx.payoutItem.updateMany.mockResolvedValue({ count: 2 })
  tx.payoutBatch.updateMany.mockResolvedValue({ count: 1 })
})

describe('POST /api/payout-batches/[id]/cancel', () => {
  it('cancels only pending items and records the reason, timestamp and actor', async () => {
    const response = await POST(request(), context())

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.cancelledItemCount).toBe(2)
    expect(body.batch).toEqual(
      expect.objectContaining({
        id: BATCH,
        status: 'cancelled',
        successCount: 2,
        failedCount: 1,
        cancellationReason: 'Wrong recipient list uploaded',
        cancelledById: OWNER,
      }),
    )
    expect(body.batch.cancelledAt).toEqual(expect.any(String))

    expect(tx.payoutItem.updateMany).toHaveBeenCalledWith({
      where: { batchId: BATCH, status: 'pending' },
      data: { status: 'cancelled' },
    })
    const batchUpdate = tx.payoutBatch.updateMany.mock.calls[0][0]
    expect(batchUpdate.data).toEqual({
      status: 'cancelled',
      cancelledAt: expect.any(Date),
      cancellationReason: 'Wrong recipient list uploaded',
      cancelledById: OWNER,
    })
    // Counters are never touched by cancellation.
    expect(batchUpdate.data).not.toHaveProperty('successCount')
    expect(batchUpdate.data).not.toHaveProperty('failedCount')
  })

  it('scopes the batch lookup to the caller', async () => {
    await POST(request(), context())
    expect(prisma.payoutBatch.findFirst).toHaveBeenCalledWith({ where: { id: BATCH, userId: OWNER } })
  })

  it('rejects cancelling a batch that is already completed', async () => {
    vi.mocked(prisma.payoutBatch.findFirst).mockResolvedValue({
      ...processingBatch,
      status: 'completed',
      completedAt: new Date(),
    } as any)

    const response = await POST(request(), context())

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'Payout batch is already completed' })
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('rejects a batch whose completedAt is set even if its status lags', async () => {
    vi.mocked(prisma.payoutBatch.findFirst).mockResolvedValue({ ...processingBatch, completedAt: new Date() } as any)
    expect((await POST(request(), context())).status).toBe(409)
  })

  it('rejects cancelling a batch twice', async () => {
    vi.mocked(prisma.payoutBatch.findFirst).mockResolvedValue({
      ...processingBatch,
      status: 'cancelled',
      cancelledAt: new Date(),
    } as any)

    const response = await POST(request(), context())

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'Payout batch is already cancelled' })
  })

  it('rejects with 409 when no pending items remain, without stamping the batch', async () => {
    tx.payoutItem.updateMany.mockResolvedValue({ count: 0 })

    const response = await POST(request(), context())

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'Payout batch has no pending items to cancel' })
    expect(tx.payoutBatch.updateMany).not.toHaveBeenCalled()
  })

  it('rejects with 409 when the batch completes concurrently', async () => {
    tx.payoutBatch.updateMany.mockResolvedValue({ count: 0 })

    const response = await POST(request(), context())

    expect(response.status).toBe(409)
    expect(tx.payoutBatch.updateMany.mock.calls[0][0].where).toEqual({
      id: BATCH,
      userId: OWNER,
      completedAt: null,
      cancelledAt: null,
      status: { notIn: ['completed', 'cancelled'] },
    })
  })

  it('returns 404 for a batch the caller does not own', async () => {
    vi.mocked(prisma.payoutBatch.findFirst).mockResolvedValue(null)

    const response = await POST(request(), context())

    expect(response.status).toBe(404)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('requires a non-empty reason of at most 500 chars', async () => {
    expect((await POST(request({}), context())).status).toBe(400)
    expect((await POST(request({ reason: '   ' }), context())).status).toBe(400)
    expect((await POST(request({ reason: 'x'.repeat(501) }), context())).status).toBe(400)
    expect((await POST(request('not json'), context())).status).toBe(400)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('rejects unauthenticated requests', async () => {
    expect((await POST(request(undefined, null), context())).status).toBe(401)
    expect((await POST(request(undefined, 'bad-token'), context())).status).toBe(401)
  })

  it('returns 500 when the database fails', async () => {
    tx.payoutItem.updateMany.mockRejectedValue(new Error('connection refused'))

    const response = await POST(request(), context())

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Failed to cancel payout batch' })
  })
})
