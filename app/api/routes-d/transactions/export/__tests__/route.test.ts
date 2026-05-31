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

function req(qs = '?from=2026-01-01&to=2026-12-31', auth = 'Bearer token'): NextRequest {
  return new NextRequest(`http://localhost/api/routes-d/transactions/export${qs}`, {
    method: 'GET',
    headers: auth ? { authorization: auth } : {},
  })
}

async function readStreamBody(res: Response): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  return text
}

beforeEach(() => {
  vi.resetAllMocks()
  mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
  mockedUserFind.mockResolvedValue({ id: 'user-1' } as never)
})

describe('GET /api/routes-d/transactions/export', () => {
  it('returns 401 without a valid token', async () => {
    mockedVerify.mockResolvedValue(null as never)
    expect((await GET(req('', ''))).status).toBe(401)
  })

  it('returns 400 when from/to are missing', async () => {
    expect((await GET(req(''))).status).toBe(400)
  })

  it('returns 400 for invalid dates', async () => {
    expect((await GET(req('?from=nope&to=also-nope'))).status).toBe(400)
  })

  it('streams a CSV of the user\'s transactions in range', async () => {
    mockedTxFindMany.mockResolvedValue([
      { id: 'tx-1', type: 'deposit', status: 'completed', amount: 50, currency: 'USDC', createdAt: new Date('2026-02-01T00:00:00Z') },
    ] as never)

    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/csv')
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="transactions.csv"')
    expect(res.body).toBeInstanceOf(ReadableStream)

    const body = await readStreamBody(res)
    expect(body.split('\n')[0]).toBe('id,type,status,amount,currency,createdAt')
    expect(body).toContain('tx-1,deposit,completed,50.00,USDC')
  })

  it('applies date range filters and uses cursor-based pagination', async () => {
    const fullBatch = Array.from({ length: 500 }, (_, i) => ({
      id: `tx-${i}`,
      type: 'deposit',
      status: 'completed',
      amount: 50,
      currency: 'USDC',
      createdAt: new Date('2026-02-01T00:00:00Z'),
    }))
    mockedTxFindMany
      .mockResolvedValueOnce(fullBatch as never)
      .mockResolvedValueOnce([] as never)

    const res = await GET(req('?from=2026-01-01T00:00:00Z&to=2026-06-30T23:59:59Z'))
    expect(res.status).toBe(200)
    await readStreamBody(res)

    expect(mockedTxFindMany).toHaveBeenNthCalledWith(1, {
      where: {
        userId: 'user-1',
        createdAt: {
          gte: new Date('2026-01-01T00:00:00Z'),
          lte: new Date('2026-06-30T23:59:59Z'),
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 500,
      select: {
        id: true,
        type: true,
        status: true,
        amount: true,
        currency: true,
        createdAt: true,
      },
    })
    expect(mockedTxFindMany).toHaveBeenNthCalledWith(2, {
      where: {
        userId: 'user-1',
        createdAt: {
          gte: new Date('2026-01-01T00:00:00Z'),
          lte: new Date('2026-06-30T23:59:59Z'),
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 500,
      cursor: { id: 'tx-499' },
      skip: 1,
      select: {
        id: true,
        type: true,
        status: true,
        amount: true,
        currency: true,
        createdAt: true,
      },
    })
  })
})
