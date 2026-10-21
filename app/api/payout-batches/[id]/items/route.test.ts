import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from './route'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    payoutBatch: { findFirst: vi.fn() },
    payoutItem: { findMany: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const OWNER = '11111111-1111-4111-8111-111111111111'
const BATCH_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function getRequest(query = '', token: string | null = 'owner-token') {
  return new NextRequest(`http://localhost/api/payout-batches/${BATCH_ID}/items${query}`, {
    method: 'GET',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

const context = (id = BATCH_ID) => ({ params: Promise.resolve({ id }) })

const mockItems = [
  {
    id: 'item-1',
    batchId: BATCH_ID,
    recipientIdentifier: 'GADDR1',
    amount: { toString: () => '100.000000' },
    payoutType: 'stellar',
    status: 'success',
    txHash: 'tx-hash-1',
    errorMessage: null,
    createdAt: new Date('2026-10-01T12:00:00Z'),
    updatedAt: new Date('2026-10-01T12:00:01Z'),
  },
  {
    id: 'item-2',
    batchId: BATCH_ID,
    recipientIdentifier: 'GADDR2',
    amount: { toString: () => '50.000000' },
    payoutType: 'stellar',
    status: 'failed',
    txHash: null,
    errorMessage: 'op_underfunded',
    createdAt: new Date('2026-10-01T12:00:00Z'),
    updatedAt: new Date('2026-10-01T12:00:02Z'),
  },
  {
    id: 'item-3',
    batchId: BATCH_ID,
    recipientIdentifier: 'GADDR3',
    amount: { toString: () => '25.000000' },
    payoutType: 'stellar',
    status: 'pending',
    txHash: null,
    errorMessage: null,
    createdAt: new Date('2026-10-01T12:00:00Z'),
    updatedAt: new Date('2026-10-01T12:00:00Z'),
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockImplementation(async (token: string) =>
    token === 'owner-token' ? ({ userId: 'privy-owner' } as any) : null,
  )
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: OWNER, role: 'freelancer' } as any)
  vi.mocked(prisma.payoutBatch.findFirst).mockResolvedValue({ id: BATCH_ID, userId: OWNER } as any)
  vi.mocked(prisma.payoutItem.findMany).mockResolvedValue(mockItems as any)
})

describe('GET /api/payout-batches/[id]/items', () => {
  it('lists items in the batch and includes txHash and errorMessage when present', async () => {
    const res = await GET(getRequest(), context())

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toHaveLength(3)

    expect(body.items[0]).toEqual({
      id: 'item-1',
      batchId: BATCH_ID,
      recipientIdentifier: 'GADDR1',
      amount: '100.000000',
      payoutType: 'stellar',
      status: 'success',
      txHash: 'tx-hash-1',
      errorMessage: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    })

    expect(body.items[1].txHash).toBeNull()
    expect(body.items[1].errorMessage).toBe('op_underfunded')

    expect(prisma.payoutBatch.findFirst).toHaveBeenCalledWith({
      where: { id: BATCH_ID, userId: OWNER },
      select: { id: true },
    })
    expect(prisma.payoutItem.findMany).toHaveBeenCalledWith({
      where: { batchId: BATCH_ID },
      orderBy: { createdAt: 'asc' },
      select: expect.any(Object),
    })
  })

  it('filters by status when status query parameter is pending, success, or failed', async () => {
    vi.mocked(prisma.payoutItem.findMany).mockResolvedValue([mockItems[0]] as any)

    const res = await GET(getRequest('?status=success'), context())

    expect(res.status).toBe(200)
    expect(prisma.payoutItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { batchId: BATCH_ID, status: 'success' },
      }),
    )
  })

  it('rejects unsupported status query parameter', async () => {
    const res = await GET(getRequest('?status=invalid_status'), context())

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain("Invalid status filter 'invalid_status'")
    expect(prisma.payoutItem.findMany).not.toHaveBeenCalled()
  })

  it('restricts visibility to batch owner and returns 404 when batch is not found or owned by another', async () => {
    vi.mocked(prisma.payoutBatch.findFirst).mockResolvedValue(null)

    const res = await GET(getRequest(), context())

    expect(res.status).toBe(404)
    expect(prisma.payoutBatch.findFirst).toHaveBeenCalledWith({
      where: { id: BATCH_ID, userId: OWNER },
      select: { id: true },
    })
    expect(prisma.payoutItem.findMany).not.toHaveBeenCalled()
  })

  it('returns 400 when payout batch ID is missing', async () => {
    const res = await GET(getRequest(), context('   '))
    expect(res.status).toBe(400)
    expect(prisma.payoutBatch.findFirst).not.toHaveBeenCalled()
  })

  it('rejects unauthenticated requests', async () => {
    const res = await GET(getRequest('', null), context())
    expect(res.status).toBe(401)
    expect(prisma.payoutBatch.findFirst).not.toHaveBeenCalled()
  })

  it('returns 500 when database fails', async () => {
    vi.mocked(prisma.payoutItem.findMany).mockRejectedValue(new Error('DB failure'))

    const res = await GET(getRequest(), context())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Failed to fetch payout batch items')
  })
})
