import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ verifyAuthToken: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn() } }))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    transaction: { findUnique: vi.fn() },
  },
}))

import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { GET } from '../route'

const mockedVerify = vi.mocked(verifyAuthToken)
const mockedUserFind = vi.mocked(prisma.user.findUnique)
const mockedTxFind = vi.mocked(prisma.transaction.findUnique)

function makeGET(id = 'tx-1'): NextRequest {
  return new NextRequest(`http://localhost/api/routes-b/withdrawals/${id}`, {
    method: 'GET',
    headers: { authorization: 'Bearer token' },
  })
}

describe('GET /api/routes-b/withdrawals/[id]', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.unstubAllGlobals()
    mockedVerify.mockResolvedValue({ userId: 'privy-1' } as never)
    mockedUserFind.mockResolvedValue({ id: 'user-1' } as never)
    delete process.env.OFFRAMP_STATUS_URL
  })

  it('falls back to transaction status when upstream fails after retries', async () => {
    process.env.OFFRAMP_STATUS_URL = 'https://offramp.example/status'
    mockedTxFind.mockResolvedValue({
      id: 'tx-1',
      userId: 'user-1',
      type: 'withdrawal',
      status: 'pending',
      amount: 123,
      currency: 'USDC',
      error: null,
      txHash: 'hash-1',
      createdAt: new Date(),
    } as never)

    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    vi.spyOn(Math, 'random').mockReturnValue(0)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })))

    const promise = GET(makeGET(), { params: Promise.resolve({ id: 'tx-1' }) })
    await vi.advanceTimersByTimeAsync(5_000)
    const res = await promise
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.withdrawal.status).toBe('pending')

    vi.useRealTimers()
  })

  it('uses upstream status when upstream succeeds', async () => {
    process.env.OFFRAMP_STATUS_URL = 'https://offramp.example/status'
    mockedTxFind.mockResolvedValue({
      id: 'tx-1',
      userId: 'user-1',
      type: 'withdrawal',
      status: 'pending',
      amount: 123,
      currency: 'USDC',
      error: null,
      txHash: 'hash-1',
      createdAt: new Date(),
    } as never)

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'completed', description: 'done' }),
      } as any),
    )

    const res = await GET(makeGET(), { params: Promise.resolve({ id: 'tx-1' }) })
    const json = await res.json()
    expect(json.withdrawal.status).toBe('completed')
    expect(json.withdrawal.description).toBe('done')
  })
})

