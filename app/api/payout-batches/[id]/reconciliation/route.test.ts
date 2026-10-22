import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from './route'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    payoutBatch: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    payoutItem: { groupBy: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const OWNER = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const ADMIN = '99999999-9999-4999-8999-999999999999'
const BATCH = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function request(token: string | null = 'owner-token') {
  return new NextRequest(`http://localhost/api/payout-batches/${BATCH}/reconciliation`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

const context = (id = BATCH) => ({ params: Promise.resolve({ id }) })

const consistentItems = [
  { status: 'success', _count: { _all: 2 }, _sum: { amount: '300' } },
  { status: 'failed', _count: { _all: 1 }, _sum: { amount: '50' } },
  { status: 'pending', _count: { _all: 1 }, _sum: { amount: '150' } },
]

beforeEach(() => {
  vi.clearAllMocks()
  const users: Record<string, { id: string; role: string }> = {
    'privy-owner': { id: OWNER, role: 'freelancer' },
    'privy-other': { id: OTHER, role: 'freelancer' },
    'privy-admin': { id: ADMIN, role: 'admin' },
  }
  vi.mocked(verifyAuthToken).mockImplementation((async (token: string) => {
    const map: Record<string, string> = {
      'owner-token': 'privy-owner',
      'other-token': 'privy-other',
      'admin-token': 'privy-admin',
    }
    return map[token] ? { userId: map[token] } : null
  }) as any)
  vi.mocked(prisma.user.findUnique).mockImplementation((async (args: any) => users[args.where.privyId] ?? null) as any)
  vi.mocked(prisma.payoutBatch.findUnique).mockResolvedValue({
    id: BATCH,
    userId: OWNER,
    status: 'processing',
    totalAmount: '500.000000',
    totalRecipients: 4,
    successCount: 2,
    failedCount: 1,
  } as any)
  vi.mocked(prisma.payoutItem.groupBy).mockResolvedValue(consistentItems as any)
})

describe('GET /api/payout-batches/[id]/reconciliation', () => {
  it('reports a reconciled batch when stored counters match the item rows', async () => {
    const response = await GET(request(), context())

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual(
      expect.objectContaining({
        batchId: BATCH,
        reconciled: true,
        mismatches: [],
        stored: { successCount: 2, failedCount: 1, totalAmount: '500.000000', totalRecipients: 4 },
        computed: { successCount: 2, failedCount: 1, totalAmount: '500.000000', totalRecipients: 4 },
        itemCountByStatus: { success: 2, failed: 1, pending: 1 },
      }),
    )
    expect(prisma.payoutItem.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { batchId: BATCH } }),
    )
  })

  it('flags every drifted field explicitly and never writes a correction', async () => {
    vi.mocked(prisma.payoutBatch.findUnique).mockResolvedValue({
      id: BATCH,
      userId: OWNER,
      status: 'completed',
      totalAmount: '480.000000',
      totalRecipients: 4,
      successCount: 3,
      failedCount: 0,
    } as any)

    const response = await GET(request(), context())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.reconciled).toBe(false)
    expect(body.mismatches).toEqual([
      { field: 'successCount', stored: 3, computed: 2, difference: -1 },
      { field: 'failedCount', stored: 0, computed: 1, difference: 1 },
      { field: 'totalAmount', stored: '480.000000', computed: '500.000000', difference: '20.000000' },
    ])
    expect(logger.warn).toHaveBeenCalled()
    expect(prisma.payoutBatch.update).not.toHaveBeenCalled()
    expect(prisma.payoutBatch.updateMany).not.toHaveBeenCalled()
  })

  it('flags a recipient count mismatch when item rows are missing', async () => {
    vi.mocked(prisma.payoutItem.groupBy).mockResolvedValue(consistentItems.slice(0, 2) as any)

    const body = await (await GET(request(), context())).json()

    expect(body.mismatches).toEqual(
      expect.arrayContaining([
        { field: 'totalRecipients', stored: 4, computed: 3, difference: -1 },
        { field: 'totalAmount', stored: '500.000000', computed: '350.000000', difference: '-150.000000' },
      ]),
    )
  })

  it('handles a batch with no items', async () => {
    vi.mocked(prisma.payoutItem.groupBy).mockResolvedValue([] as any)

    const body = await (await GET(request(), context())).json()

    expect(body.computed).toEqual({ successCount: 0, failedCount: 0, totalAmount: '0.000000', totalRecipients: 0 })
    expect(body.reconciled).toBe(false)
  })

  it('lets an admin reconcile another user batch', async () => {
    const response = await GET(request('admin-token'), context())
    expect(response.status).toBe(200)
  })

  it('hides the batch from other non-admin users with a 404', async () => {
    const response = await GET(request('other-token'), context())

    expect(response.status).toBe(404)
    expect(prisma.payoutItem.groupBy).not.toHaveBeenCalled()
  })

  it('returns 404 for a missing batch', async () => {
    vi.mocked(prisma.payoutBatch.findUnique).mockResolvedValue(null)
    expect((await GET(request(), context())).status).toBe(404)
  })

  it('rejects unauthenticated requests', async () => {
    expect((await GET(request(null), context())).status).toBe(401)
    expect((await GET(request('bad-token'), context())).status).toBe(401)
  })

  it('returns 400 for an empty batch id', async () => {
    expect((await GET(request(), context(' '))).status).toBe(400)
  })

  it('returns 500 when the database fails', async () => {
    vi.mocked(prisma.payoutItem.groupBy).mockRejectedValue(new Error('connection refused'))

    const response = await GET(request(), context())

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Failed to reconcile payout batch' })
  })
})
