import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    transaction: { findMany: vi.fn() },
  },
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedTransactionFind = vi.mocked(prisma.transaction.findMany)

const USER_ID = 'user-1'

const fakeWithdrawals = [
  { id: 'tx-1', status: 'completed', amount: 500, currency: 'USD', createdAt: new Date() },
  { id: 'tx-2', status: 'pending', amount: 200, currency: 'USD', createdAt: new Date() },
]

function makeGET(query = '', auth = 'Bearer token'): NextRequest {
  return new NextRequest(
    `http://localhost/api/routes-d/withdrawals${query}`,
    {
      method: 'GET',
      headers: auth ? { authorization: auth } : {},
    },
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
  mockedUserFind.mockResolvedValue({ id: USER_ID } as never)
  mockedTransactionFind.mockResolvedValue(fakeWithdrawals as never)
})

describe('GET /api/routes-d/withdrawals', () => {
  it('returns 401 without authorization header', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await GET(makeGET('', ''))
    expect(res.status).toBe(401)
  })

  it('returns 401 with invalid token', async () => {
    mockedVerify.mockResolvedValue(null as never)
    const res = await GET(makeGET('', 'Bearer bad'))
    expect(res.status).toBe(401)
  })

  it('returns 404 when user is not found', async () => {
    mockedUserFind.mockResolvedValue(null as never)
    const res = await GET(makeGET())
    expect(res.status).toBe(404)
  })

  it('returns withdrawals for the authenticated user', async () => {
    const res = await GET(makeGET())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.withdrawals).toHaveLength(2)
    expect(json.withdrawals[0].id).toBe('tx-1')
    expect(mockedTransactionFind).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: USER_ID, type: 'withdrawal' }) }),
    )
  })

  it('returns an empty array when user has no withdrawals', async () => {
    mockedTransactionFind.mockResolvedValue([] as never)
    const res = await GET(makeGET())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.withdrawals).toHaveLength(0)
  })

  it('filters by valid status query param', async () => {
    mockedTransactionFind.mockResolvedValue([fakeWithdrawals[0]] as never)
    const res = await GET(makeGET('?status=completed'))
    expect(res.status).toBe(200)
    expect(mockedTransactionFind).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'completed' }) }),
    )
  })

  it('returns 400 for invalid status filter', async () => {
    const res = await GET(makeGET('?status=invalid'))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/invalid status/i)
  })

  it('respects the limit query param', async () => {
    mockedTransactionFind.mockResolvedValue([fakeWithdrawals[0]] as never)
    const res = await GET(makeGET('?limit=5'))
    expect(res.status).toBe(200)
    expect(mockedTransactionFind).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5 }),
    )
  })

  it('clamps limit to a maximum of 100', async () => {
    mockedTransactionFind.mockResolvedValue([] as never)
    await GET(makeGET('?limit=999'))
    expect(mockedTransactionFind).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100 }),
    )
  })

  it('uses a default limit of 20 when none provided', async () => {
    mockedTransactionFind.mockResolvedValue([] as never)
    await GET(makeGET())
    expect(mockedTransactionFind).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20 }),
    )
  })

  it('amounts are serialized as numbers in the response', async () => {
    mockedTransactionFind.mockResolvedValue([{ id: 'tx-1', status: 'completed', amount: 500, currency: 'USD', createdAt: new Date() }] as never)
    const res = await GET(makeGET())
    const json = await res.json()
    expect(typeof json.withdrawals[0].amount).toBe('number')
    expect(json.withdrawals[0].amount).toBe(500)
  })

  it('only returns withdrawals owned by the authenticated user', async () => {
    await GET(makeGET())
    const call = mockedTransactionFind.mock.calls[0][0]
    expect((call as any).where.userId).toBe(USER_ID)
  })
})