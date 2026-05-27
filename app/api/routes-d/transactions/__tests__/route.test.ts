import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: { user: { findUnique: vi.fn() }, transaction: { findMany: vi.fn(), count: vi.fn() } },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedTxFindMany = vi.mocked(prisma.transaction.findMany)
const mockedTxCount = vi.mocked(prisma.transaction.count)

function req(auth = 'Bearer token', query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/routes-d/transactions${query}`, {
    method: 'GET',
    headers: auth ? { authorization: auth } : {},
  })
}

const tx = {
  id: 'tx-1', type: 'withdrawal', status: 'completed', amount: 100, currency: 'USDC',
  txHash: 'hash', invoice: { invoiceNumber: 'INV-01' }, userId: 'user-1', createdAt: new Date()
}

beforeEach(() => {
  vi.resetAllMocks()
  mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
  mockedUserFind.mockResolvedValue({ id: 'user-1' } as never)
})

describe('GET /api/routes-d/transactions', () => {
  it('returns 401 without a valid token', async () => {
    mockedVerify.mockResolvedValue(null as never)
    expect((await GET(req(''))).status).toBe(401)
  })

  it('returns 401 when the user is not found', async () => {
    mockedUserFind.mockResolvedValue(null as never)
    expect((await GET(req())).status).toBe(401)
  })

  it('returns 400 for invalid type', async () => {
    expect((await GET(req('Bearer token', '?type=invalid'))).status).toBe(400)
  })

  it('returns 400 for invalid status', async () => {
    expect((await GET(req('Bearer token', '?status=invalid'))).status).toBe(400)
  })

  it('returns the transactions for the user', async () => {
    mockedTxFindMany.mockResolvedValue([tx] as never)
    mockedTxCount.mockResolvedValue(1 as never)
    const res = await GET(req())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.transactions).toHaveLength(1)
    expect(json.transactions[0].id).toBe('tx-1')
    expect(json.pagination.total).toBe(1)
  })
})
