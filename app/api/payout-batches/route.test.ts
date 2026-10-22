import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET, POST } from './route'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    payoutBatch: { create: vi.fn(), findMany: vi.fn() },
  },
}))
vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))

import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const OWNER = '11111111-1111-4111-8111-111111111111'
const BATCH_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function postRequest(body: unknown, token: string | null = 'owner-token') {
  return new NextRequest('http://localhost/api/payout-batches', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function getRequest(query = '', token: string | null = 'owner-token') {
  return new NextRequest(`http://localhost/api/payout-batches${query}`, {
    method: 'GET',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

const validPayload = {
  totalRecipients: 2,
  totalAmount: '150.500000',
  items: [
    { recipientIdentifier: 'GADDR1', amount: '100.250000', payoutType: 'stellar' },
    { recipientIdentifier: 'GADDR2', amount: '50.250000', payoutType: 'stellar' },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyAuthToken).mockImplementation(async (token: string) =>
    token === 'owner-token' ? ({ userId: 'privy-owner' } as any) : null,
  )
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: OWNER, role: 'freelancer' } as any)
  vi.mocked(prisma.payoutBatch.create).mockImplementation(async (args: any) => ({
    id: BATCH_ID,
    userId: OWNER,
    status: args.data.status,
    totalAmount: args.data.totalAmount,
    totalRecipients: args.data.totalRecipients,
    scheduledAt: args.data.scheduledAt,
    items: args.data.items.create.map((item: any, idx: number) => ({
      id: `item-${idx + 1}`,
      batchId: BATCH_ID,
      ...item,
    })),
  }))
  vi.mocked(prisma.payoutBatch.findMany).mockResolvedValue([
    {
      id: BATCH_ID,
      userId: OWNER,
      status: 'pending',
      totalAmount: '150.500000',
      totalRecipients: 2,
      createdAt: new Date(),
    } as any,
  ])
})

describe('POST /api/payout-batches', () => {
  it('creates a batch with nested items defaulting to pending status', async () => {
    const res = await POST(postRequest(validPayload))

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.batch).toBeDefined()
    expect(body.batch.id).toBe(BATCH_ID)
    expect(body.batch.status).toBe('pending')
    expect(body.batch.items).toHaveLength(2)

    expect(prisma.payoutBatch.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: OWNER,
        status: 'pending',
        totalRecipients: 2,
        scheduledAt: null,
      }),
      include: { items: true },
    })
  })

  it('supports optional scheduledAt for deferred execution', async () => {
    const scheduledTime = '2026-12-01T10:00:00.000Z'
    const res = await POST(postRequest({ ...validPayload, scheduledAt: scheduledTime }))

    expect(res.status).toBe(201)
    const createData = vi.mocked(prisma.payoutBatch.create).mock.calls[0][0].data
    expect(createData.scheduledAt).toEqual(new Date(scheduledTime))
  })

  it('rejects when totalRecipients does not match item count', async () => {
    const res = await POST(postRequest({ ...validPayload, totalRecipients: 3 }))

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('totalRecipients (3) does not match the actual number of items (2)')
    expect(prisma.payoutBatch.create).not.toHaveBeenCalled()
  })

  it('rejects when totalAmount does not match the sum of item amounts', async () => {
    const res = await POST(postRequest({ ...validPayload, totalAmount: '200.000000' }))

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('does not match the sum of item amounts')
    expect(prisma.payoutBatch.create).not.toHaveBeenCalled()
  })

  it('rejects duplicate recipientIdentifier entries within the same batch', async () => {
    const duplicatePayload = {
      totalRecipients: 2,
      totalAmount: '100.000000',
      items: [
        { recipientIdentifier: 'GADDR_DUPLICATE', amount: '50.000000', payoutType: 'stellar' },
        { recipientIdentifier: 'GADDR_DUPLICATE', amount: '50.000000', payoutType: 'stellar' },
      ],
    }

    const res = await POST(postRequest(duplicatePayload))

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Duplicate recipientIdentifier found within the batch')
    expect(prisma.payoutBatch.create).not.toHaveBeenCalled()
  })

  it('rejects non-positive amounts', async () => {
    const zeroPayload = {
      totalRecipients: 1,
      totalAmount: '0.000000',
      items: [{ recipientIdentifier: 'GADDR1', amount: '0.000000', payoutType: 'stellar' }],
    }

    const res = await POST(postRequest(zeroPayload))
    expect(res.status).toBe(400)
    expect(prisma.payoutBatch.create).not.toHaveBeenCalled()
  })

  it('rejects invalid scheduledAt date string', async () => {
    const res = await POST(postRequest({ ...validPayload, scheduledAt: 'not-a-date' }))
    expect(res.status).toBe(400)
    expect(prisma.payoutBatch.create).not.toHaveBeenCalled()
  })

  it('rejects invalid JSON body', async () => {
    const res = await POST(postRequest('invalid-json'))
    expect(res.status).toBe(400)
    expect(prisma.payoutBatch.create).not.toHaveBeenCalled()
  })

  it('rejects unauthenticated requests', async () => {
    const res = await POST(postRequest(validPayload, null))
    expect(res.status).toBe(401)
    expect(prisma.payoutBatch.create).not.toHaveBeenCalled()
  })

  it('returns 500 when database fails', async () => {
    vi.mocked(prisma.payoutBatch.create).mockRejectedValue(new Error('DB failure'))

    const res = await POST(postRequest(validPayload))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Failed to create payout batch')
  })
})

describe('GET /api/payout-batches', () => {
  it('lists payout batches for the caller', async () => {
    const res = await GET(getRequest())

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.batches).toHaveLength(1)
    expect(prisma.payoutBatch.findMany).toHaveBeenCalledWith({
      where: { userId: OWNER },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { items: true } } },
    })
  })

  it('filters by status when provided in query parameters', async () => {
    const res = await GET(getRequest('?status=pending'))

    expect(res.status).toBe(200)
    expect(prisma.payoutBatch.findMany).toHaveBeenCalledWith({
      where: { userId: OWNER, status: 'pending' },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { items: true } } },
    })
  })

  it('rejects unauthenticated GET requests', async () => {
    const res = await GET(getRequest('', null))
    expect(res.status).toBe(401)
    expect(prisma.payoutBatch.findMany).not.toHaveBeenCalled()
  })

  it('returns 500 when database fetch fails', async () => {
    vi.mocked(prisma.payoutBatch.findMany).mockRejectedValue(new Error('DB error'))
    const res = await GET(getRequest())
    expect(res.status).toBe(500)
  })
})
