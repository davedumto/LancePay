import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET, POST } from '@/app/api/cron/execute-account-deletions/route'
import { DELETION_STATUS } from '@/lib/account-deletion'

vi.mock('@/lib/db', () => ({
  prisma: {
    accountDeletionRequest: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
    user: {
      update: vi.fn(),
    },
    invoice: {
      count: vi.fn(),
    },
    dispute: {
      count: vi.fn(),
    },
    payoutBatch: {
      count: vi.fn(),
    },
    withdrawalTransaction: {
      count: vi.fn(),
    },
    $transaction: vi.fn((fn) => fn(prisma)),
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { prisma } from '@/lib/db'

describe('Account Deletion Executor Cron (#1892)', () => {
  const CRON_SECRET = 'test-cron-secret-123'

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CRON_SECRET = CRON_SECRET
    // Default blockers check to empty (all counts = 0)
    vi.mocked(prisma.invoice.count).mockResolvedValue(0)
    vi.mocked(prisma.dispute.count).mockResolvedValue(0)
    vi.mocked(prisma.payoutBatch.count).mockResolvedValue(0)
    vi.mocked(prisma.withdrawalTransaction.count).mockResolvedValue(0)
  })

  it('rejects unauthorized requests without CRON_SECRET', async () => {
    const req = new Request('http://localhost:3000/api/cron/execute-account-deletions', {
      headers: { authorization: 'Bearer wrong-secret' },
    })

    const res = await GET(req)
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toBe('Unauthorized')
  })

  it('claims and completes a due pending deletion request when no blockers exist', async () => {
    const now = new Date()
    const dueRequest = {
      id: 'req-due-1',
      userId: 'user-1',
      status: DELETION_STATUS.PENDING,
      reason: 'User requested removal',
      scheduledAt: new Date(now.getTime() - 1000 * 60), // due 1 minute ago
    }

    vi.mocked(prisma.accountDeletionRequest.findMany).mockResolvedValue([dueRequest as any])
    vi.mocked(prisma.accountDeletionRequest.updateMany).mockResolvedValue({ count: 1 })
    vi.mocked(prisma.accountDeletionRequest.update).mockResolvedValue({} as any)
    vi.mocked(prisma.user.update).mockResolvedValue({} as any)

    const req = new Request('http://localhost:3000/api/cron/execute-account-deletions', {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    })

    const res = await GET(req)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.completed).toBe(1)
    expect(json.parked).toBe(0)
    expect(json.racedOrSkipped).toBe(0)

    // Verify conditional update claim
    expect(prisma.accountDeletionRequest.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'req-due-1',
        status: DELETION_STATUS.PENDING,
        scheduledAt: { lte: expect.any(Date) },
      },
      data: {
        status: DELETION_STATUS.IN_PROGRESS,
      },
    })

    // Verify completion
    expect(prisma.accountDeletionRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'req-due-1' },
        data: expect.objectContaining({
          status: DELETION_STATUS.COMPLETED,
          completedAt: expect.any(Date),
        }),
      })
    )
  })

  it('ignores cancelled or already processed rows', async () => {
    // Only pending rows with scheduledAt <= now are fetched
    vi.mocked(prisma.accountDeletionRequest.findMany).mockResolvedValue([])

    const req = new Request('http://localhost:3000/api/cron/execute-account-deletions', {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    })

    const res = await POST(req)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.processed).toBe(0)
    expect(json.completed).toBe(0)
    expect(prisma.accountDeletionRequest.updateMany).not.toHaveBeenCalled()
  })

  it('handles race condition when row was cancelled between find and claim', async () => {
    const now = new Date()
    const racedRequest = {
      id: 'req-raced-1',
      userId: 'user-2',
      status: DELETION_STATUS.PENDING,
      reason: null,
      scheduledAt: new Date(now.getTime() - 1000 * 60),
    }

    vi.mocked(prisma.accountDeletionRequest.findMany).mockResolvedValue([racedRequest as any])
    // The conditional updateMany returns count: 0 because user cancelled right before
    vi.mocked(prisma.accountDeletionRequest.updateMany).mockResolvedValue({ count: 0 })

    const req = new Request('http://localhost:3000/api/cron/execute-account-deletions', {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    })

    const res = await GET(req)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.completed).toBe(0)
    expect(json.racedOrSkipped).toBe(1)

    // Should not proceed to delete or update user
    expect(prisma.user.update).not.toHaveBeenCalled()
  })

  it('parks request with blocker reason when newly created blockers are detected', async () => {
    const now = new Date()
    const newlyBlockedRequest = {
      id: 'req-blocked-1',
      userId: 'user-3',
      status: DELETION_STATUS.PENDING,
      reason: 'Closing account',
      scheduledAt: new Date(now.getTime() - 1000 * 60),
    }

    vi.mocked(prisma.accountDeletionRequest.findMany).mockResolvedValue([newlyBlockedRequest as any])
    vi.mocked(prisma.accountDeletionRequest.updateMany).mockResolvedValue({ count: 1 })
    // Re-check blockers detects active unpaid invoice
    vi.mocked(prisma.invoice.count).mockResolvedValue(2)
    vi.mocked(prisma.accountDeletionRequest.update).mockResolvedValue({} as any)

    const req = new Request('http://localhost:3000/api/cron/execute-account-deletions', {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    })

    const res = await GET(req)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.completed).toBe(0)
    expect(json.parked).toBe(1)

    // Must be parked in BLOCKED status with reason appended
    expect(prisma.accountDeletionRequest.update).toHaveBeenCalledWith({
      where: { id: 'req-blocked-1' },
      data: {
        status: DELETION_STATUS.BLOCKED,
        reason: 'Closing account [Blocked: unpaid_invoices (2)]',
      },
    })

    // User must NOT be deleted
    expect(prisma.user.update).not.toHaveBeenCalled()
  })
})
