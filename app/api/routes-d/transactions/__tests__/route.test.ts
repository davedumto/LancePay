import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/db', () => ({
  prisma: { user: { findUnique: vi.fn() }, transaction: { findMany: vi.fn() } },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedTxFindMany = vi.mocked(prisma.transaction.findMany)

function req(auth = 'Bearer token', query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/routes-d/transactions${query}`, {
    method: 'GET',
    headers: auth ? { authorization: auth } : {},
  })
}

const tx1 = {
  id: 'tx-1', type: 'withdrawal', status: 'completed', amount: 100, currency: 'USDC',
  txHash: 'hash', invoice: { invoiceNumber: 'INV-01' }, userId: 'user-1', createdAt: new Date('2026-01-01T10:00:00Z')
}

const tx2 = {
  id: 'tx-2', type: 'payment', status: 'pending', amount: 200, currency: 'USDC',
  txHash: 'hash2', invoice: null, userId: 'user-1', createdAt: new Date('2026-01-01T09:00:00Z')
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

  it('returns transactions with nextCursor when more results exist', async () => {
    mockedTxFindMany.mockResolvedValue([tx1, tx2] as never)
    const res = await GET(req('Bearer token', '?limit=1'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.transactions).toHaveLength(1)
    expect(json.transactions[0].id).toBe('tx-1')
    expect(json.nextCursor).toBe('2026-01-01T10:00:00.000Z')
  })

  it('returns transactions without nextCursor when no more results exist', async () => {
    mockedTxFindMany.mockResolvedValue([tx1] as never)
    const res = await GET(req('Bearer token', '?limit=20'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.transactions).toHaveLength(1)
    expect(json.transactions[0].id).toBe('tx-1')
    expect(json.nextCursor).toBeNull()
  })

  it('uses cursor to paginate results', async () => {
    mockedTxFindMany.mockResolvedValue([tx2] as never)
    const cursor = '2026-01-01T10:00:00.000Z'
    const res = await GET(req('Bearer token', `?cursor=${encodeURIComponent(cursor)}&limit=20`))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.transactions).toHaveLength(1)
    expect(json.transactions[0].id).toBe('tx-2')
    expect(mockedTxFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: { lt: new Date(cursor) },
        }),
      }),
    )
  })

  it('respects limit parameter', async () => {
    mockedTxFindMany.mockResolvedValue([tx1] as never)
    const res = await GET(req('Bearer token', '?limit=5'))
    expect(res.status).toBe(200)
    expect(mockedTxFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 6, // limit + 1 to check for next page
      }),
    )
  })

  it('defaults to limit of 20 when not specified', async () => {
    mockedTxFindMany.mockResolvedValue([tx1] as never)
    const res = await GET(req('Bearer token'))
    expect(res.status).toBe(200)
    expect(mockedTxFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 21, // 20 + 1 to check for next page
      }),
    )
  })

  it('enforces maximum limit of 100', async () => {
    mockedTxFindMany.mockResolvedValue([tx1] as never)
    const res = await GET(req('Bearer token', '?limit=200'))
    expect(res.status).toBe(200)
    expect(mockedTxFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 101, // 100 + 1 to check for next page
      }),
    )
  })
})
