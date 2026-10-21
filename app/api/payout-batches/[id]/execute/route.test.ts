import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from './route'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    wallet: { findUnique: vi.fn() },
    payoutBatch: { findFirst: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    payoutItem: { findMany: vi.fn(), update: vi.fn(), count: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))
vi.mock('@/lib/stellar', () => ({ debitDelegatedUSDC: vi.fn() }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { debitDelegatedUSDC } from '@/lib/stellar'

const OWNER = '11111111-1111-4111-8111-111111111111'
const BATCH_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const WALLET_ADDRESS = 'GOWNERWALLETADDRESS'

function postRequest(token: string | null = 'owner-token') {
  return new NextRequest(`http://localhost/api/payout-batches/${BATCH_ID}/execute`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

const context = (id = BATCH_ID) => ({ params: Promise.resolve({ id }) })

const mockPendingBatch = {
  id: BATCH_ID,
  userId: OWNER,
  status: 'pending',
  totalRecipients: 2,
  totalAmount: '150.000000',
  successCount: 0,
  failedCount: 0,
  results: [],
  completedAt: null,
  cancelledAt: null,
}

const mockPendingItems = [
  {
    id: 'item-1',
    batchId: BATCH_ID,
    recipientIdentifier: 'GRECIPIENT1',
    amount: { toString: () => '100.000000' },
    payoutType: 'stellar',
    status: 'pending',
  },
  {
    id: 'item-2',
    batchId: BATCH_ID,
    recipientIdentifier: 'GRECIPIENT2',
    amount: { toString: () => '50.000000' },
    payoutType: 'stellar',
    status: 'pending',
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  process.env.WITHDRAWAL_DELEGATE_SECRET_KEY = 'SDELEGATE_KEY'
  vi.mocked(verifyAuthToken).mockImplementation(async (token: string) =>
    token === 'owner-token' ? ({ userId: 'privy-owner' } as any) : null,
  )
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: OWNER, role: 'freelancer' } as any)
  vi.mocked(prisma.wallet.findUnique).mockResolvedValue({ address: WALLET_ADDRESS } as any)
  vi.mocked(prisma.payoutBatch.findFirst).mockResolvedValue(mockPendingBatch as any)
  vi.mocked(prisma.payoutItem.findMany).mockResolvedValue(mockPendingItems as any)
  vi.mocked(prisma.payoutBatch.updateMany).mockResolvedValue({ count: 1 })
  vi.mocked(debitDelegatedUSDC).mockResolvedValue('tx-hash-ok')
  vi.mocked(prisma.payoutItem.count).mockResolvedValue(0)
  vi.mocked(prisma.payoutBatch.update).mockImplementation(async (args: any) => ({
    ...mockPendingBatch,
    status: args.data.status,
    completedAt: args.data.completedAt,
    successCount: 2,
    failedCount: 0,
    results: args.data.results,
  }))
})

describe('POST /api/payout-batches/[id]/execute', () => {
  it('executes all pending items in a batch, updates counters and marks batch completed', async () => {
    const res = await POST(postRequest(), context())

    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.processedCount).toBe(2)
    expect(body.successCount).toBe(2)
    expect(body.failedCount).toBe(0)
    expect(body.results).toHaveLength(2)
    expect(body.results[0]).toEqual({
      itemId: 'item-1',
      recipientIdentifier: 'GRECIPIENT1',
      amount: '100.000000',
      status: 'success',
      txHash: 'tx-hash-ok',
      processedAt: expect.any(String),
    })

    expect(debitDelegatedUSDC).toHaveBeenCalledTimes(2)
    expect(prisma.payoutItem.update).toHaveBeenCalledWith({
      where: { id: 'item-1' },
      data: { status: 'success', txHash: 'tx-hash-ok', errorMessage: null },
    })
    expect(prisma.payoutItem.update).toHaveBeenCalledWith({
      where: { id: 'item-2' },
      data: { status: 'success', txHash: 'tx-hash-ok', errorMessage: null },
    })

    expect(prisma.payoutBatch.update).toHaveBeenCalledWith({
      where: { id: BATCH_ID },
      data: expect.objectContaining({
        status: 'completed',
        completedAt: expect.any(Date),
        successCount: { increment: 2 },
        failedCount: { increment: 0 },
        results: expect.any(Array),
      }),
    })
  })

  it('processes items independently so failure of one item does not abort remaining items', async () => {
    vi.mocked(debitDelegatedUSDC)
      .mockRejectedValueOnce(new Error('op_underfunded'))
      .mockResolvedValueOnce('tx-hash-item-2')

    const res = await POST(postRequest(), context())

    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.processedCount).toBe(2)
    expect(body.successCount).toBe(1)
    expect(body.failedCount).toBe(1)

    expect(prisma.payoutItem.update).toHaveBeenCalledWith({
      where: { id: 'item-1' },
      data: { status: 'failed', errorMessage: 'op_underfunded' },
    })
    expect(prisma.payoutItem.update).toHaveBeenCalledWith({
      where: { id: 'item-2' },
      data: { status: 'success', txHash: 'tx-hash-item-2', errorMessage: null },
    })

    expect(prisma.payoutBatch.update).toHaveBeenCalledWith({
      where: { id: BATCH_ID },
      data: expect.objectContaining({
        successCount: { increment: 1 },
        failedCount: { increment: 1 },
      }),
    })
  })

  it('preserves existing results and appends new item outcomes', async () => {
    const existingResult = {
      itemId: 'item-prev',
      recipientIdentifier: 'GPREV',
      amount: '10.000000',
      status: 'success' as const,
      txHash: 'tx-prev',
      processedAt: '2026-10-01T10:00:00.000Z',
    }
    vi.mocked(prisma.payoutBatch.findFirst).mockResolvedValue({
      ...mockPendingBatch,
      results: [existingResult],
    } as any)

    const res = await POST(postRequest(), context())
    expect(res.status).toBe(200)

    const updateCall = vi.mocked(prisma.payoutBatch.update).mock.calls[0][0]
    expect(updateCall.data.results).toHaveLength(3)
    expect(updateCall.data.results[0]).toEqual(existingResult)
  })

  it('guards against double-execution if the batch is already completed', async () => {
    vi.mocked(prisma.payoutBatch.findFirst).mockResolvedValue({
      ...mockPendingBatch,
      status: 'completed',
      completedAt: new Date(),
    } as any)

    const res = await POST(postRequest(), context())
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe('Payout batch is already completed')
    expect(debitDelegatedUSDC).not.toHaveBeenCalled()
  })

  it('guards against double-execution if the batch is currently executing', async () => {
    vi.mocked(prisma.payoutBatch.findFirst).mockResolvedValue({
      ...mockPendingBatch,
      status: 'processing',
    } as any)

    const res = await POST(postRequest(), context())
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe('Payout batch is currently executing')
    expect(debitDelegatedUSDC).not.toHaveBeenCalled()
  })

  it('guards against double-execution when batch is cancelled', async () => {
    vi.mocked(prisma.payoutBatch.findFirst).mockResolvedValue({
      ...mockPendingBatch,
      status: 'cancelled',
      cancelledAt: new Date(),
    } as any)

    const res = await POST(postRequest(), context())
    expect(res.status).toBe(409)
    expect(debitDelegatedUSDC).not.toHaveBeenCalled()
  })

  it('guards against concurrent execution races when atomic claim fails', async () => {
    vi.mocked(prisma.payoutBatch.updateMany).mockResolvedValue({ count: 0 })

    const res = await POST(postRequest(), context())
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toContain('Payout batch is currently executing or already finished')
    expect(debitDelegatedUSDC).not.toHaveBeenCalled()
  })

  it('returns 400 when there are no pending items in the batch', async () => {
    vi.mocked(prisma.payoutItem.findMany).mockResolvedValue([])

    const res = await POST(postRequest(), context())
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('No pending items to execute in this batch')
    expect(debitDelegatedUSDC).not.toHaveBeenCalled()
  })

  it('returns 400 when the account has no wallet', async () => {
    vi.mocked(prisma.wallet.findUnique).mockResolvedValue(null)

    const res = await POST(postRequest(), context())
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('No wallet found for this account')
    expect(debitDelegatedUSDC).not.toHaveBeenCalled()
  })

  it('returns 404 when batch is not found or owned by another user', async () => {
    vi.mocked(prisma.payoutBatch.findFirst).mockResolvedValue(null)

    const res = await POST(postRequest(), context())
    expect(res.status).toBe(404)
    expect(prisma.payoutBatch.findFirst).toHaveBeenCalledWith({
      where: { id: BATCH_ID, userId: OWNER },
    })
    expect(debitDelegatedUSDC).not.toHaveBeenCalled()
  })

  it('returns 400 when batch ID is missing', async () => {
    const res = await POST(postRequest(), context('   '))
    expect(res.status).toBe(400)
  })

  it('rejects unauthenticated requests', async () => {
    const res = await POST(postRequest(null), context())
    expect(res.status).toBe(401)
    expect(debitDelegatedUSDC).not.toHaveBeenCalled()
  })

  it('returns 500 when database fails unexpectedly', async () => {
    vi.mocked(prisma.payoutBatch.findFirst).mockRejectedValue(new Error('DB failure'))

    const res = await POST(postRequest(), context())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Failed to execute payout batch')
  })
})
