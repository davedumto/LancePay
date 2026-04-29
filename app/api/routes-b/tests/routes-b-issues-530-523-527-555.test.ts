import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const loggerMock = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}

const prismaMock = {
  user: { findUnique: vi.fn() },
  wallet: { findUnique: vi.fn() },
  transaction: { findUnique: vi.fn(), aggregate: vi.fn(), findMany: vi.fn() },
  invoice: { findUnique: vi.fn(), groupBy: vi.fn() },
  tag: { findMany: vi.fn() },
  invoiceTag: { findMany: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
}

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: loggerMock }))
vi.mock('@/lib/db', () => ({ prisma: prismaMock }))

import { verifyAuthToken } from '@/lib/auth'

describe('routes-b issues 530/523/527/555', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    vi.mocked(verifyAuthToken).mockResolvedValue({ userId: 'privy-1' } as never)
    prismaMock.user.findUnique.mockResolvedValue({ id: 'user-1' })
  })

  it('530: wallet GET maps timeout error to stable code and logs structured payload', async () => {
    process.env.CHAIN_RPC_WALLET_BALANCE_URL = 'https://rpc.example.com/wallet'
    prismaMock.wallet.findUnique.mockResolvedValue({ id: 'w1', address: 'GABC', createdAt: new Date() })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })))

    const { GET } = await import('../wallet/route')
    const req = new NextRequest('http://localhost/api/routes-b/wallet', {
      headers: { authorization: 'Bearer token' },
    })
    const res = await GET(req)
    const json = await res.json()

    expect(res.status).toBe(504)
    expect(json.code).toBe('WALLET_TIMEOUT')
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        attempt: 1,
        errorClass: 'timeout',
        durationMs: expect.any(Number),
      }),
      expect.any(String),
    )
    delete process.env.CHAIN_RPC_WALLET_BALANCE_URL
  })

  it('523: withRetry retries transient failures and stops retrying on 4xx', async () => {
    const { withRetry } = await import('../_lib/retry')

    let tries = 0
    const result = await withRetry(async () => {
      tries += 1
      if (tries < 3) {
        const error = new Error('5xx') as Error & { status?: number }
        error.status = 503
        throw error
      }
      return 'ok'
    }, { baseDelayMs: 1 })
    expect(result).toBe('ok')
    expect(tries).toBe(3)

    const error = new Error('bad request') as Error & { status?: number }
    error.status = 400
    await expect(withRetry(async () => { throw error }, { baseDelayMs: 1 })).rejects.toThrow('bad request')
    expect(loggerMock.warn).toHaveBeenCalledTimes(2)
  })

  it('527: dashboard summary query count stays constant with large grouped data', async () => {
    const middlewareSpy = vi.fn()
    prismaMock.invoice.groupBy.mockImplementation(async () => {
      middlewareSpy({ model: 'Invoice', action: 'groupBy' })
      return [
        { status: 'paid', _count: { id: 900 } },
        { status: 'pending', _count: { id: 100 } },
      ]
    })
    prismaMock.transaction.aggregate
      .mockImplementationOnce(async () => {
        middlewareSpy({ model: 'Transaction', action: 'aggregate' })
        return { _sum: { amount: 1000 } }
      })
      .mockImplementationOnce(async () => {
        middlewareSpy({ model: 'Transaction', action: 'aggregate' })
        return { _sum: { amount: 200 } }
      })
    prismaMock.transaction.findMany.mockImplementation(async () => {
      middlewareSpy({ model: 'Transaction', action: 'findMany' })
      return []
    })

    const { buildDashboardSummary } = await import('../_lib/aggregations')
    const result = await buildDashboardSummary('user-1', new Date('2026-03-20T00:00:00.000Z'))
    expect(result.queryCount).toBe(4)
    expect(middlewareSpy).toHaveBeenCalledTimes(4)
  })

  it('555: attach/detach tags is idempotent and validates ownership', async () => {
    prismaMock.invoice.findUnique.mockResolvedValue({ id: 'inv-1', userId: 'user-1' })
    prismaMock.tag.findMany.mockResolvedValue([
      { id: 'tag-1', userId: 'user-1', name: 'Alpha', color: 'red' },
      { id: 'tag-2', userId: 'user-1', name: 'Beta', color: 'blue' },
    ])
    prismaMock.invoiceTag.create
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: 'P2002' }))
    prismaMock.invoiceTag.deleteMany.mockResolvedValue({ count: 1 })

    const { POST, DELETE } = await import('../invoices/[id]/tags/route')
    const postReq = new NextRequest('http://localhost/api/routes-b/invoices/inv-1/tags', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: JSON.stringify({ tagIds: ['tag-1', 'tag-2'] }),
    })
    const postRes = await POST(postReq, { params: Promise.resolve({ id: 'inv-1' }) })
    const postJson = await postRes.json()
    expect(postRes.status).toBe(200)
    expect(postJson.createdTagIds).toEqual(['tag-1'])

    const delReq = new NextRequest('http://localhost/api/routes-b/invoices/inv-1/tags', {
      method: 'DELETE',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: JSON.stringify({ tagIds: ['tag-1', 'tag-2'] }),
    })
    const delRes = await DELETE(delReq, { params: Promise.resolve({ id: 'inv-1' }) })
    expect(delRes.status).toBe(200)

    prismaMock.tag.findMany.mockResolvedValue([{ id: 'tag-3', userId: 'user-2' }])
    const foreignReq = new NextRequest('http://localhost/api/routes-b/invoices/inv-1/tags', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: JSON.stringify({ tagIds: ['tag-3'] }),
    })
    const foreignRes = await POST(foreignReq, { params: Promise.resolve({ id: 'inv-1' }) })
    expect(foreignRes.status).toBe(403)
  })
})
