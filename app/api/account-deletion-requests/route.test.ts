import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => {
  const prisma = {
    user: { findUnique: vi.fn() },
    accountDeletionRequest: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    invoice: { count: vi.fn() },
    dispute: { count: vi.fn() },
    payoutBatch: { count: vi.fn() },
    withdrawalTransaction: { count: vi.fn() },
    notification: { create: vi.fn() },
    $transaction: vi.fn(),
  }
  return { prisma }
})
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/email', () => ({ sendAccountDeletionScheduledEmail: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { GET, POST } from './route'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { sendAccountDeletionScheduledEmail } from '@/lib/email'

const NOW = new Date('2026-09-25T12:00:00.000Z')
const GRACE_END = new Date('2026-10-25T12:00:00.000Z')
const mockUser = { id: 'user-1', email: 'user@example.com', name: 'Ada' }

function makeRequest(method: 'GET' | 'POST', body?: string, headers: Record<string, string> = { authorization: 'Bearer token' }) {
  return new NextRequest('http://localhost/api/account-deletion-requests', { method, headers, body })
}

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'del-1',
    status: 'pending',
    reason: null,
    scheduledAt: GRACE_END,
    cancelledAt: null,
    completedAt: null,
    createdAt: NOW,
    ...overrides,
  }
}

function setBlockerCounts(counts: { invoices?: number; disputes?: number; batches?: number; withdrawals?: number }) {
  vi.mocked(prisma.invoice.count).mockResolvedValue(counts.invoices ?? 0)
  vi.mocked(prisma.dispute.count).mockResolvedValue(counts.disputes ?? 0)
  vi.mocked(prisma.payoutBatch.count).mockResolvedValue(counts.batches ?? 0)
  vi.mocked(prisma.withdrawalTransaction.count).mockResolvedValue(counts.withdrawals ?? 0)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
  vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as never)
  vi.mocked(prisma.$transaction).mockImplementation(((fn: (tx: typeof prisma) => unknown) => fn(prisma)) as never)
  vi.mocked(prisma.accountDeletionRequest.findUnique).mockResolvedValue(null)
  vi.mocked(sendAccountDeletionScheduledEmail).mockResolvedValue({ success: true })
  setBlockerCounts({})
})

afterEach(() => {
  vi.useRealTimers()
})

describe('POST /api/account-deletion-requests', () => {
  it('returns 401 without a bearer token', async () => {
    const res = await POST(makeRequest('POST', undefined, {}))
    expect(res.status).toBe(401)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('returns 401 when the token is invalid', async () => {
    vi.mocked(verifyAuthToken).mockResolvedValue(null)
    const res = await POST(makeRequest('POST'))
    expect(res.status).toBe(401)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('creates a pending request with a 30-day grace period and offers a data export', async () => {
    vi.mocked(prisma.accountDeletionRequest.create).mockImplementation((async ({ data }: { data: Record<string, unknown> }) =>
      pendingRow({ reason: data.reason, scheduledAt: data.scheduledAt })) as never)

    const res = await POST(makeRequest('POST', JSON.stringify({ reason: '  Leaving the platform  ' })))

    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.graceDays).toBe(30)
    expect(body.deletionRequest).toMatchObject({
      id: 'del-1',
      status: 'pending',
      reason: 'Leaving the platform',
      scheduledAt: GRACE_END.toISOString(),
      cancellable: true,
      remainingGraceSeconds: 30 * 24 * 60 * 60,
    })
    expect(body.dataExport).toEqual({ offered: true, availableUntil: GRACE_END.toISOString() })

    expect(prisma.accountDeletionRequest.create).toHaveBeenCalledWith({
      data: { userId: 'user-1', reason: 'Leaving the platform', status: 'pending', scheduledAt: GRACE_END },
      select: expect.any(Object),
    })
    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'user-1', type: 'account_deletion_data_export' }),
    })
    expect(sendAccountDeletionScheduledEmail).toHaveBeenCalledWith({
      to: 'user@example.com',
      name: 'Ada',
      scheduledAt: GRACE_END,
    })
  })

  it('accepts an empty body', async () => {
    vi.mocked(prisma.accountDeletionRequest.create).mockResolvedValue(pendingRow() as never)
    const res = await POST(makeRequest('POST'))
    expect(res.status).toBe(202)
    expect(prisma.accountDeletionRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reason: null }) }),
    )
  })

  it('rejects malformed JSON', async () => {
    const res = await POST(makeRequest('POST', '{not json'))
    expect(res.status).toBe(400)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('rejects unknown body fields such as a client-supplied userId', async () => {
    const res = await POST(makeRequest('POST', JSON.stringify({ userId: 'someone-else' })))
    expect(res.status).toBe(400)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('rejects a reason longer than 500 characters', async () => {
    const res = await POST(makeRequest('POST', JSON.stringify({ reason: 'x'.repeat(501) })))
    expect(res.status).toBe(400)
  })

  it('blocks deletion while the user has unpaid invoices', async () => {
    setBlockerCounts({ invoices: 2 })
    const res = await POST(makeRequest('POST'))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.blockers).toEqual([{ type: 'unpaid_invoices', count: 2 }])
    expect(prisma.accountDeletionRequest.create).not.toHaveBeenCalled()
    expect(prisma.notification.create).not.toHaveBeenCalled()
    expect(sendAccountDeletionScheduledEmail).not.toHaveBeenCalled()
  })

  it('blocks deletion while a dispute is active', async () => {
    setBlockerCounts({ disputes: 1 })
    const res = await POST(makeRequest('POST'))
    expect(res.status).toBe(409)
    expect((await res.json()).blockers).toEqual([{ type: 'active_disputes', count: 1 }])
  })

  it('blocks deletion while payouts or withdrawals are pending', async () => {
    setBlockerCounts({ batches: 1, withdrawals: 2 })
    const res = await POST(makeRequest('POST'))
    expect(res.status).toBe(409)
    expect((await res.json()).blockers).toEqual([{ type: 'pending_payouts', count: 3 }])
  })

  it('reports every blocking category at once', async () => {
    setBlockerCounts({ invoices: 1, disputes: 1, withdrawals: 1 })
    const res = await POST(makeRequest('POST'))
    expect((await res.json()).blockers).toEqual([
      { type: 'unpaid_invoices', count: 1 },
      { type: 'active_disputes', count: 1 },
      { type: 'pending_payouts', count: 1 },
    ])
  })

  it('checks blockers using the real status fields, scoped to the user', async () => {
    vi.mocked(prisma.accountDeletionRequest.create).mockResolvedValue(pendingRow() as never)
    await POST(makeRequest('POST'))

    const party = { OR: [{ userId: 'user-1' }, { clientId: 'user-1' }] }
    expect(prisma.invoice.count).toHaveBeenCalledWith({
      where: { ...party, status: { in: ['pending', 'overdue'] } },
    })
    expect(prisma.dispute.count).toHaveBeenCalledWith({
      where: { invoice: party, status: { notIn: ['resolved', 'closed'] }, resolvedAt: null },
    })
    expect(prisma.payoutBatch.count).toHaveBeenCalledWith({
      where: { userId: 'user-1', status: { in: ['pending', 'processing'] } },
    })
    expect(prisma.withdrawalTransaction.count).toHaveBeenCalledWith({
      where: { userId: 'user-1', status: { in: ['pending', 'interactive', 'submitted'] } },
    })
  })

  it('returns 409 with the existing request when one is already pending', async () => {
    vi.mocked(prisma.accountDeletionRequest.findUnique).mockResolvedValue(pendingRow() as never)
    const res = await POST(makeRequest('POST'))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.deletionRequest.id).toBe('del-1')
    expect(prisma.accountDeletionRequest.create).not.toHaveBeenCalled()
    expect(prisma.accountDeletionRequest.updateMany).not.toHaveBeenCalled()
  })

  it('re-opens a previously cancelled request with a fresh grace period', async () => {
    vi.mocked(prisma.accountDeletionRequest.findUnique).mockResolvedValue(
      pendingRow({ status: 'cancelled', cancelledAt: new Date('2026-09-01T00:00:00Z') }) as never,
    )
    vi.mocked(prisma.accountDeletionRequest.updateMany).mockResolvedValue({ count: 1 })
    vi.mocked(prisma.accountDeletionRequest.findUniqueOrThrow).mockResolvedValue(pendingRow() as never)

    const res = await POST(makeRequest('POST'))

    expect(res.status).toBe(202)
    expect(prisma.accountDeletionRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'del-1', status: 'cancelled' },
      data: {
        status: 'pending',
        reason: null,
        scheduledAt: GRACE_END,
        cancelledAt: null,
        completedAt: null,
        createdAt: NOW,
      },
    })
    expect(prisma.accountDeletionRequest.create).not.toHaveBeenCalled()
  })

  it('returns 409 when a concurrent request re-opened the cancelled row first', async () => {
    vi.mocked(prisma.accountDeletionRequest.findUnique).mockResolvedValue(pendingRow({ status: 'cancelled' }) as never)
    vi.mocked(prisma.accountDeletionRequest.updateMany).mockResolvedValue({ count: 0 })
    vi.mocked(prisma.accountDeletionRequest.findUniqueOrThrow).mockResolvedValue(pendingRow() as never)

    const res = await POST(makeRequest('POST'))

    expect(res.status).toBe(409)
    expect(prisma.notification.create).not.toHaveBeenCalled()
  })

  it('returns 409 when a concurrent create hits the per-user unique constraint', async () => {
    vi.mocked(prisma.accountDeletionRequest.create).mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
    )
    const res = await POST(makeRequest('POST'))
    expect(res.status).toBe(409)
    expect(sendAccountDeletionScheduledEmail).not.toHaveBeenCalled()
  })

  it('returns a generic 500 without leaking internals', async () => {
    vi.mocked(prisma.$transaction).mockRejectedValue(new Error('connection refused at 10.0.0.5'))
    const res = await POST(makeRequest('POST'))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('10.0.0.5')
  })
})

describe('GET /api/account-deletion-requests', () => {
  it('returns 401 without a bearer token', async () => {
    const res = await GET(makeRequest('GET', undefined, {}))
    expect(res.status).toBe(401)
  })

  it('returns null when the user has no deletion request', async () => {
    const res = await GET(makeRequest('GET'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ deletionRequest: null })
  })

  it('returns the caller\'s pending request with remaining grace time', async () => {
    vi.mocked(prisma.accountDeletionRequest.findUnique).mockResolvedValue(pendingRow() as never)
    vi.setSystemTime(new Date('2026-10-24T12:00:00.000Z'))

    const res = await GET(makeRequest('GET'))
    const body = await res.json()

    expect(prisma.accountDeletionRequest.findUnique).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      select: expect.any(Object),
    })
    expect(body.deletionRequest).toMatchObject({
      id: 'del-1',
      status: 'pending',
      cancellable: true,
      remainingGraceSeconds: 24 * 60 * 60,
    })
  })

  it('marks a pending request past its grace period as not cancellable', async () => {
    vi.mocked(prisma.accountDeletionRequest.findUnique).mockResolvedValue(pendingRow() as never)
    vi.setSystemTime(new Date('2026-10-26T00:00:00.000Z'))

    const body = await (await GET(makeRequest('GET'))).json()

    expect(body.deletionRequest.cancellable).toBe(false)
    expect(body.deletionRequest.remainingGraceSeconds).toBe(0)
  })
})
