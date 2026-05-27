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
    const body = await res.text()
    expect(body.split('\n')[0]).toBe('id,type,status,amount,currency,createdAt')
    expect(body).toContain('tx-1,deposit,completed,50.00,USDC')
  })
})
