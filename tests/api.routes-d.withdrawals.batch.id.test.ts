import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const payoutBatchFindFirst = vi.fn()
const loggerError = vi.fn()

vi.mock('@/lib/auth', () => ({ verifyAuthToken }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    payoutBatch: { findFirst: payoutBatchFindFirst },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: loggerError } }))

const BASE_URL = 'http://localhost/api/routes-d/withdrawals/batch/batch_1'

function makeRequest(headers: Record<string, string> = { authorization: 'Bearer token' }) {
  return new NextRequest(BASE_URL, { method: 'GET', headers })
}

const routeParams = { params: Promise.resolve({ id: 'batch_1' }) }

async function importRoute() {
  return import('@/app/api/routes-d/withdrawals/batch/[id]/route')
}

describe('GET /api/routes-d/withdrawals/batch/[id] (#1192)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when no auth token is provided', async () => {
    const { GET } = await importRoute()
    const response = await GET(makeRequest({}), routeParams)

    expect(response.status).toBe(401)
    expect(payoutBatchFindFirst).not.toHaveBeenCalled()
  })

  it('returns 401 when the token is invalid', async () => {
    verifyAuthToken.mockResolvedValue(null)

    const { GET } = await importRoute()
    const response = await GET(makeRequest(), routeParams)

    expect(response.status).toBe(401)
  })

  it('returns 401 when the user is not found', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue(null)

    const { GET } = await importRoute()
    const response = await GET(makeRequest(), routeParams)

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: 'User not found' })
  })

  it('returns 404 when the batch does not exist or belongs to another user', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    payoutBatchFindFirst.mockResolvedValue(null)

    const { GET } = await importRoute()
    const response = await GET(makeRequest(), routeParams)

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ error: 'Batch not found' })
    expect(payoutBatchFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'batch_1', userId: 'user_1' },
      }),
    )
  })

  it('returns the batch with item status counts', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    payoutBatchFindFirst.mockResolvedValue({
      id: 'batch_1',
      status: 'processing',
      totalAmount: '150.5',
      totalRecipients: 3,
      successCount: 1,
      failedCount: 1,
      scheduledAt: null,
      createdAt: new Date('2026-07-20T00:00:00Z'),
      completedAt: null,
      items: [
        { id: 'item_1', recipientIdentifier: 'a@x.com', amount: '50', payoutType: 'bank', status: 'completed', txHash: 'h1', errorMessage: null, updatedAt: new Date() },
        { id: 'item_2', recipientIdentifier: 'b@x.com', amount: '50', payoutType: 'bank', status: 'failed', txHash: null, errorMessage: 'insufficient funds', updatedAt: new Date() },
        { id: 'item_3', recipientIdentifier: 'c@x.com', amount: '50.5', payoutType: 'bank', status: 'pending', txHash: null, errorMessage: null, updatedAt: new Date() },
      ],
    })

    const { GET } = await importRoute()
    const response = await GET(makeRequest(), routeParams)

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.batch).toMatchObject({
      id: 'batch_1',
      status: 'processing',
      totalRecipients: 3,
      itemStatusCounts: { completed: 1, failed: 1, pending: 1 },
    })
    expect(body.batch.items).toHaveLength(3)
  })

  it('returns 500 when the database read fails', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    payoutBatchFindFirst.mockRejectedValue(new Error('db down'))

    const { GET } = await importRoute()
    const response = await GET(makeRequest(), routeParams)

    expect(response.status).toBe(500)
    expect(loggerError).toHaveBeenCalled()
  })
})
