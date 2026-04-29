import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from '../export/route'

vi.mock('@/lib/auth', () => ({
  verifyAuthToken: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    transaction: { findMany: vi.fn() },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFindUnique = vi.mocked(prisma.user.findUnique)
const mockedTransactionFindMany = vi.mocked(prisma.transaction.findMany)

function makeRequest() {
  return new NextRequest('http://localhost/api/routes-b/transactions/export', {
    headers: { authorization: 'Bearer token' },
  })
}

function tx(id: string, description = '') {
  return {
    id,
    type: 'payment',
    status: 'completed',
    amount: 42,
    currency: 'USD',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    invoice: { description },
  }
}

describe('GET /api/routes-b/transactions/export streaming', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFindUnique.mockResolvedValue({ id: 'user-1' } as never)
  })

  it('streams only the header for an empty result', async () => {
    mockedTransactionFindMany.mockResolvedValueOnce([] as never)

    const res = await GET(makeRequest())

    expect(res.headers.get('Content-Type')).toBe('text/csv')
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="transactions.csv"')
    expect(await res.text()).toBe('id,type,status,amount,currency,description,createdAt\n')
  })

  it('streams a single batch', async () => {
    mockedTransactionFindMany.mockResolvedValueOnce([tx('tx-1')] as never).mockResolvedValueOnce([] as never)

    const res = await GET(makeRequest())

    expect(await res.text()).toContain('tx-1,payment,completed,42.00,USD,,2026-01-01T00:00:00.000Z')
    expect(mockedTransactionFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 500 }))
  })

  it('streams multiple batches with cursor pagination', async () => {
    const firstBatch = Array.from({ length: 500 }, (_, index) => tx(`tx-${index}`))
    mockedTransactionFindMany
      .mockResolvedValueOnce(firstBatch as never)
      .mockResolvedValueOnce([tx('tx-500')] as never)

    const res = await GET(makeRequest())
    await res.text()

    expect(mockedTransactionFindMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: { id: 'tx-499' }, skip: 1, take: 500 }),
    )
  })

  it('escapes quotes, commas, and newlines in fields', async () => {
    mockedTransactionFindMany.mockResolvedValueOnce([tx('tx-1', 'Hello, "friend"\nagain')] as never)

    const res = await GET(makeRequest())

    expect(await res.text()).toContain('"Hello, ""friend""\nagain"')
  })
})
