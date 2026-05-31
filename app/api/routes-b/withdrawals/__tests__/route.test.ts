/**
 * Tests for GET + POST /api/routes-b/withdrawals (#727).
 *
 * Covers the happy path plus the failure modes the route guards against:
 *   - Unauthorized (missing / invalid bearer)
 *   - User not found (claims point at an account that no longer exists)
 *   - Invalid POST body (non-JSON, missing amount, non-positive amount,
 *     missing bankAccountId)
 *   - Ownership check: bankAccountId belongs to a different user → 403
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GET, POST } from '../route'
import { buildRequest, makeUser } from '../../_lib/test-helpers'

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    bankAccount: { findFirst: vi.fn() },
    transaction: {
      count: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
  },
}))

vi.mock('../../_lib/withdrawal-fees', () => ({
  calculateWithdrawalFee: vi.fn(() => ({ fee: 1, netAmount: 99 })),
}))

vi.mock('../../_lib/events', () => ({
  emitStatsInvalidated: vi.fn(),
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'

const mockedVerifyAuthToken = vi.mocked(verifyAuthToken)
const mockedUserFindUnique = vi.mocked(prisma.user.findUnique)
const mockedBankAccountFindFirst = vi.mocked(prisma.bankAccount.findFirst)
const mockedTransactionCount = vi.mocked(prisma.transaction.count)
const mockedTransactionFindMany = vi.mocked(prisma.transaction.findMany)
const mockedTransactionCreate = vi.mocked(prisma.transaction.create)

const URL = 'http://localhost/api/routes-b/withdrawals'

describe('GET /api/routes-b/withdrawals', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedVerifyAuthToken.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFindUnique.mockResolvedValue(makeUser() as never)
  })

  it('returns 401 when no bearer token is provided', async () => {
    mockedVerifyAuthToken.mockResolvedValueOnce(null as never)
    const response = await GET(buildRequest('GET', URL))
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Unauthorized' })
  })

  it('returns 404 when the claims point at a user that no longer exists', async () => {
    mockedUserFindUnique.mockResolvedValueOnce(null as never)
    const response = await GET(buildRequest('GET', URL, { token: 'token' }))
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'User not found' })
  })

  it('lists the authenticated user`s withdrawals with pagination metadata', async () => {
    mockedTransactionCount.mockResolvedValue(2 as never)
    mockedTransactionFindMany.mockResolvedValue([
      {
        id: 't1',
        type: 'withdrawal',
        status: 'completed',
        amount: 10,
        currency: 'USDC',
        createdAt: new Date('2026-05-01T00:00:00Z'),
      },
      {
        id: 't2',
        type: 'withdrawal',
        status: 'pending',
        amount: 25,
        currency: 'USDC',
        createdAt: new Date('2026-05-02T00:00:00Z'),
      },
    ] as never)

    const response = await GET(buildRequest('GET', URL, { token: 'token' }))
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.withdrawals).toHaveLength(2)
    expect(body.withdrawals[0]).toMatchObject({ id: 't1', amount: 10 })
    expect(body.pagination).toEqual({
      page: 1,
      limit: 20,
      total: 2,
      totalPages: 1,
    })
  })

  it('clamps `limit` to the documented range and honours `page`', async () => {
    mockedTransactionCount.mockResolvedValue(0 as never)
    mockedTransactionFindMany.mockResolvedValue([] as never)

    await GET(
      buildRequest('GET', `${URL}?limit=500&page=3`, { token: 'token' }),
    )

    // 500 must clamp to 100; page=3 ⇒ skip 100*2.
    expect(mockedTransactionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100, skip: 200 }),
    )
  })

  it('scopes the query to the authenticated user and the withdrawal type', async () => {
    mockedTransactionCount.mockResolvedValue(0 as never)
    mockedTransactionFindMany.mockResolvedValue([] as never)
    mockedUserFindUnique.mockResolvedValueOnce(
      makeUser({ id: 'user-xyz' }) as never,
    )

    await GET(buildRequest('GET', URL, { token: 'token' }))

    expect(mockedTransactionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-xyz', type: 'withdrawal' },
      }),
    )
  })
})

describe('POST /api/routes-b/withdrawals', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedVerifyAuthToken.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFindUnique.mockResolvedValue(makeUser({ id: 'user-1' }) as never)
  })

  function postBody(body: unknown) {
    return buildRequest('POST', URL, { token: 'token', body })
  }

  it('returns 401 when no bearer token is provided', async () => {
    mockedVerifyAuthToken.mockResolvedValueOnce(null as never)
    const response = await POST(postBody({ amount: 10, bankAccountId: 'b1' }))
    expect(response.status).toBe(401)
  })

  it('returns 400 for a malformed JSON body', async () => {
    // buildRequest serialises with JSON.stringify, so feed it something that
    // cannot be parsed as JSON when read back: send a raw text body via a
    // fresh Request, bypassing buildRequest.
    const request = new Request(URL, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token',
        'Content-Type': 'application/json',
      },
      body: 'not-json',
    })
    const response = await POST(request as never)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid JSON body' })
  })

  it('returns 400 when amount is missing', async () => {
    const response = await POST(postBody({ bankAccountId: 'b1' }))
    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatch(/amount/i)
  })

  it('returns 400 when amount is below the minimum (1)', async () => {
    const response = await POST(postBody({ amount: 0.5, bankAccountId: 'b1' }))
    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatch(/amount/i)
  })

  it('returns 400 when bankAccountId is missing', async () => {
    const response = await POST(postBody({ amount: 10 }))
    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatch(/bankAccountId/i)
  })

  it('returns 403 when the bankAccountId is not owned by the user', async () => {
    mockedBankAccountFindFirst.mockResolvedValueOnce(null as never)
    const response = await POST(
      postBody({ amount: 10, bankAccountId: 'other-users-bank' }),
    )
    expect(response.status).toBe(403)
  })

  it('creates the withdrawal transaction on the happy path', async () => {
    mockedBankAccountFindFirst.mockResolvedValueOnce({ id: 'b1' } as never)
    mockedTransactionCreate.mockResolvedValueOnce({
      id: 'tx-1',
      type: 'withdrawal',
      status: 'pending',
      amount: 99,
      currency: 'USDC',
      createdAt: new Date('2026-05-01T00:00:00Z'),
    } as never)

    const response = await POST(postBody({ amount: 100, bankAccountId: 'b1' }))
    expect(response.status).toBe(201)

    const body = await response.json()
    expect(body).toMatchObject({
      id: 'tx-1',
      type: 'withdrawal',
      status: 'pending',
      amount: 99,
      currency: 'USDC',
      fee: 1,
    })

    expect(mockedTransactionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-1',
          type: 'withdrawal',
          status: 'pending',
          amount: 99,
          currency: 'USDC',
          bankAccountId: 'b1',
        }),
      }),
    )
  })
})
