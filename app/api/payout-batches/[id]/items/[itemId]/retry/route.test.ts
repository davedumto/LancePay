import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from './route'

vi.mock('@/lib/db', () => {
  const tx = {
    payoutItem: { update: vi.fn(), count: vi.fn() },
    payoutBatch: { update: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
  }
  return {
    prisma: {
      user: { findUnique: vi.fn() },
      wallet: { findUnique: vi.fn() },
      payoutBatch: { findFirst: vi.fn() },
      payoutItem: { findFirst: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
      __tx: tx,
    },
  }
})
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))
vi.mock('@/lib/stellar', () => ({ debitDelegatedUSDC: vi.fn() }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { debitDelegatedUSDC } from '@/lib/stellar'

const tx = (prisma as any).__tx
const OWNER = '11111111-1111-4111-8111-111111111111'
const BATCH = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ITEM = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const WALLET = 'GOWNERWALLETADDRESS'
const RECIPIENT = 'GRECIPIENTADDRESS'
const completedAt = new Date('2026-10-01T12:00:00Z')

function request(token: string | null = 'owner-token') {
  return new NextRequest(`http://localhost/api/payout-batches/${BATCH}/items/${ITEM}/retry`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

const context = (id = BATCH, itemId = ITEM) => ({ params: Promise.resolve({ id, itemId }) })

const failedItem = {
  id: ITEM,
  batchId: BATCH,
  recipientIdentifier: RECIPIENT,
  amount: { toString: () => '125.500000' },
  payoutType: 'stellar',
  status: 'failed',
  txHash: null,
  errorMessage: 'op_underfunded',
}

const completedBatch = {
  id: BATCH,
  userId: OWNER,
  status: 'completed',
  successCount: 3,
  failedCount: 1,
  completedAt,
  cancelledAt: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.WITHDRAWAL_DELEGATE_SECRET_KEY = 'SDELEGATE'
  vi.mocked(verifyAuthToken).mockImplementation((async (token: string) =>
    token === 'owner-token' ? { userId: 'privy-owner' } : null) as any)
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: OWNER, role: 'freelancer' } as any)
  vi.mocked(prisma.wallet.findUnique).mockResolvedValue({ address: WALLET } as any)
  vi.mocked(prisma.payoutBatch.findFirst).mockResolvedValue(completedBatch as any)
  vi.mocked(prisma.payoutItem.findFirst).mockResolvedValue(failedItem as any)
  vi.mocked(prisma.payoutItem.updateMany).mockResolvedValue({ count: 1 } as any)
  vi.mocked(debitDelegatedUSDC).mockResolvedValue('tx-hash-123')

  tx.payoutItem.update.mockImplementation(async (args: any) => ({ ...failedItem, ...args.data }))
  tx.payoutBatch.updateMany.mockResolvedValue({ count: 1 })
  tx.payoutItem.count.mockResolvedValue(0)
  tx.payoutBatch.findUniqueOrThrow.mockResolvedValue({ ...completedBatch, successCount: 4, failedCount: 0 })
  tx.payoutBatch.update.mockImplementation(async (args: any) => ({
    ...completedBatch,
    successCount: 4,
    failedCount: 0,
    ...args.data,
  }))
})

describe('POST /api/payout-batches/[id]/items/[itemId]/retry', () => {
  it('re-sends a failed item and moves one count from failed to success', async () => {
    const response = await POST(request(), context())

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.item).toEqual({
      id: ITEM,
      status: 'success',
      txHash: 'tx-hash-123',
      amount: '125.500000',
      recipientIdentifier: RECIPIENT,
    })
    expect(body.batch).toEqual(
      expect.objectContaining({ status: 'completed', successCount: 4, failedCount: 0 }),
    )

    expect(debitDelegatedUSDC).toHaveBeenCalledWith('SDELEGATE', WALLET, RECIPIENT, '125.500000', expect.any(String))
    expect(prisma.payoutItem.updateMany).toHaveBeenCalledWith({
      where: { id: ITEM, batchId: BATCH, status: 'failed' },
      data: { status: 'processing' },
    })
    expect(tx.payoutItem.update).toHaveBeenCalledWith({
      where: { id: ITEM },
      data: { status: 'success', txHash: 'tx-hash-123', errorMessage: null },
    })
    expect(tx.payoutBatch.updateMany).toHaveBeenCalledWith({
      where: { id: BATCH, failedCount: { gt: 0 } },
      data: { failedCount: { decrement: 1 }, successCount: { increment: 1 } },
    })
  })

  it('keeps the original completedAt when every item is still terminal', async () => {
    await POST(request(), context())

    expect(tx.payoutItem.count).toHaveBeenCalledWith({
      where: { batchId: BATCH, status: { in: ['pending', 'processing'] } },
    })
    expect(tx.payoutBatch.update).toHaveBeenCalledWith({
      where: { id: BATCH },
      data: { status: 'completed', completedAt },
    })
  })

  it('reopens a completed batch when non-terminal items remain', async () => {
    tx.payoutItem.count.mockResolvedValue(1)

    const body = await (await POST(request(), context())).json()

    expect(tx.payoutBatch.update).toHaveBeenCalledWith({
      where: { id: BATCH },
      data: { status: 'processing', completedAt: null },
    })
    expect(body.batch.completedAt).toBeNull()
  })

  it('marks a not-yet-completed batch completed once the retried item was the last open one', async () => {
    vi.mocked(prisma.payoutBatch.findFirst).mockResolvedValue({ ...completedBatch, status: 'processing', completedAt: null } as any)
    tx.payoutBatch.findUniqueOrThrow.mockResolvedValue({ ...completedBatch, status: 'processing', completedAt: null })

    await POST(request(), context())

    expect(tx.payoutBatch.update).toHaveBeenCalledWith({
      where: { id: BATCH },
      data: { status: 'completed', completedAt: expect.any(Date) },
    })
  })

  it('never drives failedCount negative when the counter already drifted', async () => {
    tx.payoutBatch.updateMany.mockResolvedValue({ count: 0 })

    const response = await POST(request(), context())

    expect(response.status).toBe(200)
    expect(tx.payoutBatch.update).toHaveBeenCalledWith({
      where: { id: BATCH },
      data: { successCount: { increment: 1 } },
    })
  })

  it('puts the item back to failed with the new error and leaves counters alone when the payout fails', async () => {
    vi.mocked(debitDelegatedUSDC).mockRejectedValue({ type: 'payment_failed', message: 'op_no_destination' })

    const response = await POST(request(), context())

    expect(response.status).toBe(502)
    expect((await response.json()).item).toEqual({ id: ITEM, status: 'failed', errorMessage: 'op_no_destination' })
    expect(prisma.payoutItem.update).toHaveBeenCalledWith({
      where: { id: ITEM },
      data: { status: 'failed', errorMessage: 'op_no_destination' },
    })
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it.each(['pending', 'processing', 'success', 'cancelled'])('rejects retrying an item in %s status', async (status) => {
    vi.mocked(prisma.payoutItem.findFirst).mockResolvedValue({ ...failedItem, status } as any)

    const response = await POST(request(), context())

    expect(response.status).toBe(409)
    expect(debitDelegatedUSDC).not.toHaveBeenCalled()
  })

  it('returns 409 and sends nothing when a concurrent retry already claimed the item', async () => {
    vi.mocked(prisma.payoutItem.updateMany).mockResolvedValue({ count: 0 } as any)

    const response = await POST(request(), context())

    expect(response.status).toBe(409)
    expect(debitDelegatedUSDC).not.toHaveBeenCalled()
  })

  it('rejects retries in a cancelled batch', async () => {
    vi.mocked(prisma.payoutBatch.findFirst).mockResolvedValue({
      ...completedBatch,
      status: 'cancelled',
      cancelledAt: new Date(),
    } as any)

    expect((await POST(request(), context())).status).toBe(409)
    expect(prisma.payoutItem.findFirst).not.toHaveBeenCalled()
  })

  it('rejects unsupported payout types', async () => {
    vi.mocked(prisma.payoutItem.findFirst).mockResolvedValue({ ...failedItem, payoutType: 'bank' } as any)

    expect((await POST(request(), context())).status).toBe(422)
    expect(prisma.payoutItem.updateMany).not.toHaveBeenCalled()
  })

  it('returns 404 for a batch the caller does not own or an item outside the batch', async () => {
    vi.mocked(prisma.payoutBatch.findFirst).mockResolvedValueOnce(null)
    expect((await POST(request(), context())).status).toBe(404)
    expect(prisma.payoutBatch.findFirst).toHaveBeenCalledWith({ where: { id: BATCH, userId: OWNER } })

    vi.mocked(prisma.payoutItem.findFirst).mockResolvedValueOnce(null)
    expect((await POST(request(), context())).status).toBe(404)
    expect(prisma.payoutItem.findFirst).toHaveBeenCalledWith({ where: { id: ITEM, batchId: BATCH } })
  })

  it('returns 400 when the owner has no wallet', async () => {
    vi.mocked(prisma.wallet.findUnique).mockResolvedValue(null)
    expect((await POST(request(), context())).status).toBe(400)
    expect(prisma.payoutItem.updateMany).not.toHaveBeenCalled()
  })

  it('rejects unauthenticated requests', async () => {
    expect((await POST(request(null), context())).status).toBe(401)
    expect((await POST(request('bad-token'), context())).status).toBe(401)
  })

  it('reports the txHash when the payout was sent but recording it failed', async () => {
    tx.payoutItem.update.mockRejectedValue(new Error('connection lost'))

    const response = await POST(request(), context())

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: 'Payout was sent but its outcome could not be recorded',
      txHash: 'tx-hash-123',
    })
  })

  it('returns 500 when the database fails before any payout', async () => {
    vi.mocked(prisma.payoutBatch.findFirst).mockRejectedValue(new Error('connection refused'))

    const response = await POST(request(), context())

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Failed to retry payout item' })
  })
})
