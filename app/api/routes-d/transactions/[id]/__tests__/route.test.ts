import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: { user: { findUnique: vi.fn() }, transaction: { findUnique: vi.fn() } },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedTxFind = vi.mocked(prisma.transaction.findUnique)

const params = { params: Promise.resolve({ id: 'tx-1' }) }

function req(auth = 'Bearer token'): NextRequest {
  return new NextRequest('http://localhost/api/routes-d/transactions/tx-1', {
    method: 'GET',
    headers: auth ? { authorization: auth } : {},
  })
}

const tx = {
  id: 'tx-1', type: 'withdrawal', status: 'completed', amount: 100, currency: 'USDC',
  txHash: 'hash', invoiceId: null, userId: 'user-1', createdAt: new Date(), completedAt: new Date(),
}

beforeEach(() => {
  vi.resetAllMocks()
  mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
  mockedUserFind.mockResolvedValue({ id: 'user-1' } as never)
})

describe('GET /api/routes-d/transactions/[id]', () => {
  it('returns 401 without a valid token', async () => {
    mockedVerify.mockResolvedValue(null as never)
    expect((await GET(req(''), params)).status).toBe(401)
  })

  it('returns 404 when the user is not found', async () => {
    mockedUserFind.mockResolvedValue(null as never)
    expect((await GET(req(), params)).status).toBe(404)
  })

  it('returns 404 when the transaction does not exist', async () => {
    mockedTxFind.mockResolvedValue(null as never)
    expect((await GET(req(), params)).status).toBe(404)
  })

  it('returns 403 when the transaction belongs to another user', async () => {
    mockedTxFind.mockResolvedValue({ ...tx, userId: 'other' } as never)
    expect((await GET(req(), params)).status).toBe(403)
  })

  it('returns the transaction for its owner', async () => {
    mockedTxFind.mockResolvedValue(tx as never)
    const res = await GET(req(), params)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.transaction.id).toBe('tx-1')
    expect(json.transaction.amount).toBe(100)
    expect(json.transaction.stellarTxHash).toBe('hash')
  })
})
