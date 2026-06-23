import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyAuthToken = vi.fn()
const userFindUnique = vi.fn()
const transactionFindFirst = vi.fn()

vi.mock('@/lib/auth', () => ({
  verifyAuthToken,
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    transaction: { findFirst: transactionFindFirst },
  },
}))

function getRequest(): NextRequest {
  return new NextRequest('http://localhost/api/routes-d/transfers/abc')
}

const VALID_ID = '00000000-0000-4000-8000-000000000001'

describe('GET /api/routes-d/transfers/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when the user is not authenticated', async () => {
    verifyAuthToken.mockResolvedValue(null)

    const { GET } = await import('@/app/api/routes-d/transfers/[id]/route')
    const response = await GET(getRequest(), { params: { id: VALID_ID } })

    expect(response.status).toBe(401)
    expect(transactionFindFirst).not.toHaveBeenCalled()
  })

  it('rejects a non-UUID id with 400', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })

    const { GET } = await import('@/app/api/routes-d/transfers/[id]/route')
    const response = await GET(getRequest(), { params: { id: 'not-a-uuid' } })

    expect(response.status).toBe(400)
    expect(transactionFindFirst).not.toHaveBeenCalled()
  })

  it('returns 404 when no transfer matches the id for the current user', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    transactionFindFirst.mockResolvedValue(null)

    const { GET } = await import('@/app/api/routes-d/transfers/[id]/route')
    const response = await GET(getRequest(), { params: { id: VALID_ID } })

    expect(response.status).toBe(404)
    expect(transactionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: VALID_ID, userId: 'user_1' },
      }),
    )
  })

  it('returns the transfer with serialised decimal fields', async () => {
    verifyAuthToken.mockResolvedValue({ userId: 'privy_1' })
    userFindUnique.mockResolvedValue({ id: 'user_1' })
    transactionFindFirst.mockResolvedValue({
      id: VALID_ID,
      type: 'send',
      status: 'completed',
      amount: { toString: () => '125.50' },
      currency: 'USD',
      ngnAmount: { toString: () => '200000.00' },
      exchangeRate: { toString: () => '1592.0000' },
      invoiceId: null,
      bankAccountId: 'ba_1',
      txHash: '0xabc',
      externalId: 'ext_42',
      virtualAccountId: null,
      autoSwapTriggered: true,
      error: null,
      createdAt: new Date('2026-06-22T10:00:00Z'),
      completedAt: new Date('2026-06-22T10:05:00Z'),
    })

    const { GET } = await import('@/app/api/routes-d/transfers/[id]/route')
    const response = await GET(getRequest(), { params: { id: VALID_ID } })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.id).toBe(VALID_ID)
    expect(body.amount).toBe('125.50')
    expect(body.ngnAmount).toBe('200000.00')
    expect(body.exchangeRate).toBe('1592.0000')
    expect(body.autoSwapTriggered).toBe(true)
  })
})
